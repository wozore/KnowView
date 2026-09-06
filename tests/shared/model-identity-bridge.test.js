'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  REQUIRED_STRING_FIELDS,
  bridgeRevisionOf,
  validateModelIdentityBridgeEntries,
  readModelIdentityBridge,
  writeModelIdentityBridge,
} = require('../../src/shared/model-identity-bridge');
const { SHARED_FILES, CATALOG_GENERATOR_FILES } = require('../../src/shared/paths');

function tempBridgeFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-identity-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'model-identity-bridge.json');
}

function validEntry(overrides = {}) {
  return {
    model_key: 'kuaishou-kling-2.6-pro',
    title: 'Kling 2.6 Pro',
    vendor_key: 'kuaishou',
    detail_id: 'tool-level3:kling-2-6-pro',
    tool_card_id: 'tool-card:kling-2-6-pro',
    series_id: 'vendor-level2:kuaishou:kling',
    official_url: 'https://kling.ai',
    content_hash: 'sha256:abc123',
    verified_at: '2026-01-15T08:00:00.000Z',
    catalog_revision: 'sha256:deadbeef',
    ...overrides,
  };
}

test('paths 登记共享桥接文件与身份核验回执常量', () => {
  assert.match(SHARED_FILES.modelIdentityBridge, /model-identity-bridge\.json$/);
  assert.match(SHARED_FILES.modelIdentityBridge, new RegExp(`shared[/\\\\]model-identity-bridge\\.json$`));
  assert.match(CATALOG_GENERATOR_FILES.identityReceipts, /identity-receipts\.json$/);
});

test('validateModelIdentityBridgeEntries 合法 entries 返回空错误', () => {
  assert.deepEqual(validateModelIdentityBridgeEntries([validEntry()]), []);
  assert.deepEqual(validateModelIdentityBridgeEntries([]), []);
});

test('validateModelIdentityBridgeEntries 非数组与坏形状逐条报错', () => {
  assert.deepEqual(validateModelIdentityBridgeEntries(null), ['entries 必须是数组']);
  assert.deepEqual(validateModelIdentityBridgeEntries('nope'), ['entries 必须是数组']);
  const errors = validateModelIdentityBridgeEntries([null, 'str', {}]);
  assert.equal(errors.length, 1 + 1 + REQUIRED_STRING_FIELDS.length);
  assert.match(errors[0], /entries\[0\] 应为对象/);
  assert.match(errors[1], /entries\[1\] 应为对象/);
  assert.match(errors[2], /entries\[2\]\.model_key 缺失/);
});

test('validateModelIdentityBridgeEntries 十字段全部必填', () => {
  for (const field of REQUIRED_STRING_FIELDS) {
    const entry = validEntry();
    delete entry[field];
    const errors = validateModelIdentityBridgeEntries([entry]);
    assert.equal(errors.length, 1, `删除 ${field} 应报错`);
    assert.match(errors[0], new RegExp(`${field} 缺失`));
  }
});

test('validateModelIdentityBridgeEntries fail-closed 语法校验', () => {
  assert.match(validateModelIdentityBridgeEntries([validEntry({ model_key: 'Kuaishou-Kling' })])[0], /model_key 语法非法/);
  assert.match(validateModelIdentityBridgeEntries([validEntry({ vendor_key: 'Kuaishou' })])[0], /vendor_key 必须为小写 slug/);
  assert.match(validateModelIdentityBridgeEntries([validEntry({ verified_at: 'not-a-date' })])[0], /verified_at 应为可解析/);
});

test('bridgeRevisionOf 确定性且键序无关', () => {
  const a = [validEntry()];
  const keys = Object.keys(a[0]).reverse();
  const reorderedEntry = Object.fromEntries(keys.map(key => [key, a[0][key]]));
  assert.equal(bridgeRevisionOf([reorderedEntry]), bridgeRevisionOf(a));
  assert.notEqual(bridgeRevisionOf(a), bridgeRevisionOf([validEntry({ title: 'Changed' })]));
  assert.match(bridgeRevisionOf(a), /^sha256:[0-9a-f]{64}$/);
  assert.equal(bridgeRevisionOf(null), bridgeRevisionOf([]));
});

test('readModelIdentityBridge 缺失文件回退空结构', (t) => {
  const file = tempBridgeFile(t);
  const result = readModelIdentityBridge(file);
  assert.deepEqual(result, { schema_version: 1, revision: null, entries: [] });
  assert.ok(Object.isFrozen(result));
});

test('readModelIdentityBridge 损坏 JSON 回退空 + validation_errors', (t) => {
  const file = tempBridgeFile(t);
  fs.writeFileSync(file, '{ not json', 'utf8');
  const result = readModelIdentityBridge(file);
  assert.deepEqual(result.entries, []);
  assert.equal(result.revision, null);
});

test('readModelIdentityBridge 非法 entries 回退空 + validation_errors', (t) => {
  const file = tempBridgeFile(t);
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, entries: [{ model_key: 'bad syntax' }] }), 'utf8');
  const result = readModelIdentityBridge(file);
  assert.deepEqual(result.entries, []);
  assert.ok(Array.isArray(result.validation_errors) && result.validation_errors.length > 0);
  assert.match(result.validation_errors[0], /entries\[0\]/);
});

test('readModelIdentityBridge 合法内容校验后冻结返回', (t) => {
  const file = tempBridgeFile(t);
  const write = writeModelIdentityBridge([validEntry()], file);
  assert.equal(write.ok, true);
  const result = readModelIdentityBridge(file);
  assert.equal(result.revision, write.revision);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0], validEntry());
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.entries));
  assert.ok(Object.isFrozen(result.entries[0]));
});

test('readModelIdentityBridge 默认读取仓库初始空结构', () => {
  const result = readModelIdentityBridge();
  assert.deepEqual(result.entries, []);
  assert.equal(result.revision, null);
});

test('writeModelIdentityBridge 非法输入 fail-closed 不落盘', (t) => {
  const file = tempBridgeFile(t);
  const bad = writeModelIdentityBridge([validEntry({ model_key: 'BAD KEY' })], file);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'SHARED_MODEL_IDENTITY_BRIDGE_INVALID');
  assert.ok(Array.isArray(bad.errors) && bad.errors.length > 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal(writeModelIdentityBridge('nope', file).ok, false);
  assert.equal(fs.existsSync(file), false);
});

test('writeModelIdentityBridge 忽略调用方 revision 并内部重算', (t) => {
  const file = tempBridgeFile(t);
  const entries = [validEntry({ revision: 'sha256:forged' })];
  const write = writeModelIdentityBridge(entries, file);
  assert.equal(write.ok, true);
  assert.equal(write.revision, bridgeRevisionOf(entries));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.revision, bridgeRevisionOf(entries));
  assert.notEqual(onDisk.revision, 'sha256:forged');
});

test('writeModelIdentityBridge 原子写（无残留 tmp）且重复写覆盖', (t) => {
  const file = tempBridgeFile(t);
  const first = writeModelIdentityBridge([validEntry()], file);
  const second = writeModelIdentityBridge([validEntry(), validEntry({ model_key: 'openai-gpt-5.6-sol', detail_id: 'tool-level3:gpt-5-6-sol', tool_card_id: 'tool-card:gpt-5-6-sol', series_id: 'vendor-level2:openai:gpt' })], file);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.count, 2);
  const leftovers = fs.readdirSync(path.dirname(file)).filter(name => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.equal(readModelIdentityBridge(file).entries.length, 2);
});


test('readModelIdentityBridge 拒绝 entries 与 revision 不一致的损坏状态', (t) => {
  const file = tempBridgeFile(t);
  const written = writeModelIdentityBridge([validEntry()], file);
  assert.equal(written.ok, true);
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  payload.revision = 'sha256:forged';
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  const result = readModelIdentityBridge(file);
  assert.deepEqual(result.entries, []);
  assert.equal(result.revision, null);
  assert.match(result.validation_errors[0], /revision/);
});
