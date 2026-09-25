'use strict';

/**
 * catalog-series-migration.js —— LLM 二级系列迁移 CLI（阶段 2 预览 / 阶段 3 Apply）。
 *
 * 预览（只读）：
 *   node scripts/catalog-series-migration.js            # 人类可读
 *   node scripts/catalog-series-migration.js --json     # 结构化 JSON
 *
 * Apply（阶段 3，原子事务）：
 *   node scripts/catalog-series-migration.js --apply <targetRevision>
 *
 *   <targetRevision> 必须与预览输出的「目标 revision」完全一致；Apply 时按当前快照重新
 *   规划并重新计算目标 revision，若与传入值不一致（数据已漂移）则中止；随后通过
 *   commitSnapshotChange 五文件共同事务 + dist 重建原子提交，并绑定 expectedRevision
 *   防止提交瞬间被并发改动。提交失败自动回滚。
 */

const { loadCatalogSnapshot } = require('../src/catalog/core/index');
const { revisionOf } = require('../src/catalog/core/index');
const { loadSeriesPolicy } = require('../src/catalog/series/index');
const { planSeriesMigration } = require('../src/catalog/series/index');
const { commitSnapshotChange } = require('../src/catalog/transaction');

function currentPlan(vendorKeys = null) {
  const policy = loadSeriesPolicy();
  const current = loadCatalogSnapshot();
  const plan = planSeriesMigration(policy, current.snapshot, vendorKeys ? { vendorKeys } : {});
  plan.beforeRevision = current.revision;
  return plan;
}

function humanReport(plan) {
  const lines = [];
  lines.push(`迁移预览（阶段 2 只读，未写正式目录）`);
  if (plan.scope_vendors) lines.push(`- 厂商范围：${plan.scope_vendors.join(', ')}`);
  lines.push(`- 迁移前 revision：${plan.beforeRevision}`);
  lines.push(`- 迁移后 revision：${revisionOf(plan.snapshot)}`);
  lines.push(`- 校验：${plan.validation.ok ? '通过' : '失败 ' + JSON.stringify(plan.validation.errors.slice(0, 8))}`);
  lines.push(`- 删除碎片系列：${plan.removed_level2.length}`);
  for (const r of plan.removed_level2) lines.push(`    ${r.id}（${r.members.length} 成员）`);
  lines.push(`- 成员搬迁：${plan.members_moved.length}`);
  for (const m of plan.members_moved) lines.push(`    ${m.detail}  ${m.from} → ${m.to}`);
  lines.push(`- 新孤儿（迁移造成）：${plan.orphaned.length}`);
  for (const o of plan.orphaned) lines.push(`    ${o.detail}（${o.vendor_key}）`);
  lines.push(`- 政策历史转移：${plan.history_transitions.length}`);
  for (const item of plan.history_transitions) lines.push(`    ${item.member} → hidden_history（${item.historical_since}）`);
  for (const item of plan.history_errors) lines.push(`    历史转移目标无效：${item.member}（${item.vendor_key}）`);
  for (const vendorKey of plan.scope_errors) lines.push(`    未知厂商范围：${vendorKey}`);
  lines.push(`- 既有浮空详情警告：${plan.warnings.length}`);
  for (const w of plan.warnings) lines.push(`    ${w.code} ${w.detail}`);
  lines.push(`- id_map：${JSON.stringify(plan.id_map)}`);
  lines.push('');
  lines.push(`迁移后目标系列（L2）：`);
  const covered = ['openai', 'anthropic', 'google', 'deepseek', 'zhipu', 'baidu', 'mistral', 'cohere', 'xai', 'minimax', 'moonshot', 'alibaba', 'tencent', 'stepfun', 'xiaomi', 'nvidia', 'microsoft'];
  for (const l2 of plan.snapshot['vendor-level2']) {
    if (!covered.includes(l2.vendor_key)) continue;
    lines.push(`    ${l2.id} | ${l2.title} | ${(l2.detail_refs || []).length} 成员`);
  }
  lines.push('');
  lines.push(`- Apply 安全门禁：${plan.ok ? '通过' : '阻断（需先解决校验错误、孤儿或历史转移目标）'}`);
  if (plan.ok) {
    const scope = plan.scope_vendors ? ` --vendor ${plan.scope_vendors.join(',')}` : '';
    lines.push(`Apply：node scripts/catalog-series-migration.js --apply ${revisionOf(plan.snapshot)}${scope}`);
  }
  return lines.join('\n');
}

function applyMigration(expectedTargetRevision, vendorKeys = null) {
  const plan = currentPlan(vendorKeys);
  if (!plan.ok) {
    console.error(`迁移计划未通过安全门禁，中止 Apply：${JSON.stringify({ validation: plan.validation.errors.slice(0, 8), orphaned: plan.orphaned, history_errors: plan.history_errors, scope_errors: plan.scope_errors })}`);
    return 1;
  }
  const targetRevision = revisionOf(plan.snapshot);
  if (String(expectedTargetRevision || '') !== targetRevision) {
    console.error(`目标 revision 不匹配：传入 ${expectedTargetRevision}，实际 ${targetRevision}（数据已漂移或确认值错误），中止。`);
    return 1;
  }
  const result = commitSnapshotChange(plan.snapshot, {
    operation: 'series-migration',
    expectedRevision: plan.beforeRevision,
  });
  if (!result.ok) {
    console.error(`Apply 失败：${result.code} ${result.error || ''}`);
    return 1;
  }
  console.log(`Apply 完成：${result.beforeRevision} → ${result.targetRevision}`);
  console.log(`删除碎片：${plan.removed_level2.length}；成员搬迁：${plan.members_moved.length}；孤儿：${plan.orphaned.length}`);
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  const vendorIndex = args.indexOf('--vendor');
  const vendorValue = vendorIndex >= 0 ? args[vendorIndex + 1] : null;
  if (vendorIndex >= 0 && (!vendorValue || vendorValue.startsWith('--'))) {
    console.error('--vendor 需要一个或多个逗号分隔的厂商 key。');
    process.exitCode = 2;
    return;
  }
  const vendorKeys = vendorValue ? vendorValue.split(',').map(key => key.trim()).filter(Boolean) : null;
  if (vendorValue && !vendorKeys.length) {
    console.error('--vendor 至少需要一个厂商 key。');
    process.exitCode = 2;
    return;
  }
  if (args.includes('--apply')) {
    const idx = args.indexOf('--apply');
    const expected = args[idx + 1];
    if (!expected) {
      console.error('--apply 需要目标 revision（来自预览输出）。本命令只接受与当前数据重算一致的 revision，防止漂移。');
      return 2;
    }
    process.exitCode = applyMigration(expected, vendorKeys);
    return;
  }
  const plan = currentPlan(vendorKeys);
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({
      ok: plan.ok,
      before_revision: plan.beforeRevision,
      target_revision: revisionOf(plan.snapshot),
      scope_vendors: plan.scope_vendors,
      scope_errors: plan.scope_errors,
      validation_errors: plan.validation.errors,
      removed_level2: plan.removed_level2,
      members_moved: plan.members_moved,
      orphaned: plan.orphaned,
      history_transitions: plan.history_transitions,
      history_errors: plan.history_errors,
      warnings: plan.warnings,
      id_map: plan.id_map,
      changes: plan.changes,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(humanReport(plan) + '\n');
  }
  process.exitCode = plan.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = { currentPlan, humanReport, applyMigration, main };
