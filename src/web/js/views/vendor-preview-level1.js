import { escapeHtml, safeExternalUrl, renderTaskTypeBadges } from '../ui/ui-helpers.js';
import { ICON_EXTERNAL } from '../ui/ui-icons.js';
import { brandIconHtml } from '../ui/brand-icons.js';
import { groupKind } from '../data/vendor-series-order.mjs';

const GROUP_SECTIONS = [
  { kind: 'model_series', title: '模型系列', badge: '系列' },
  { kind: 'tool_series', title: '工具', badge: '工具' },
  { kind: 'subscription_series', title: '套餐', badge: '套餐' },
  { kind: 'other', title: '其他', badge: '分类' },
];

function renderGroupCard(item, badge) {
  return '<button class="model-tree-card" type="button" onclick="openDetail(\'' + escapeHtml(item.id) + '\')">' +
    '<span class="node-kind-badge group">' + badge + '</span><strong>' + escapeHtml(item.title) + '</strong>' + renderTaskTypeBadges(item.task_types) +
    '<p>' + escapeHtml(item.summary || '') + '</p>' +
    '<small class="intelligence-status status-' + escapeHtml(item.status === 'unknown' ? 'partial' : item.status) + '">' + escapeHtml(item.status === 'active' ? '已核实' : item.status === 'partial' ? '部分核实' : item.status === 'unknown' ? '官方资料待核验' : '资料状态未知') + '</small>' +
    '<span class="model-tree-action">进入分类 ›</span></button>';
}

function renderGroupSections(level2, detailsById) {
  const sections = GROUP_SECTIONS.map(section => ({ ...section, items: [] }));
  for (const item of level2) {
    const kind = groupKind(item, detailsById);
    const section = sections.find(candidate => candidate.kind === kind) || sections.at(-1);
    section.items.push(item);
  }
  return sections.filter(section => section.items.length).map(section =>
    '<section class="vendor-series-section"><h4>' + section.title + '</h4><div class="model-tree-grid">' +
      section.items.map(item => renderGroupCard(item, section.badge)).join('') +
    '</div></section>'
  ).join('');
}

function renderVendorLevel1(request = {}) {
  const { vendor, preview, level2 = [], details = [] } = request;
  if (!preview) return '<div class="intelligence-unavailable">厂商一级预览暂不可用。</div>';
  const detailsById = new Map(details.map(item => [item.id, item]));
  const statusText = { verified: '已核实', partial: '部分核实', conflict: '资料冲突', unavailable: '资料不可用', unknown: '官方资料待核验' }[preview.status] || '资料状态待核验';
  return '<section class="openai-root vendor-preview-level1">' +
    '<h2>' + brandIconHtml({ vendorKey: preview.vendor_key || vendor?.vendor_key, emoji: preview.icon || vendor?.icon }) + ' ' + escapeHtml(preview.title || vendor?.title || '') + '</h2>' +
    '<div class="vendor"><a href="' + escapeHtml(safeExternalUrl(preview.official_url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div>' +
    '<p class="vendor-description">' + escapeHtml(preview.description || '') + '</p>' +
    '<section class="model-tool-panel"><div class="intelligence-heading"><h3>模型与工具</h3><span class="intelligence-status status-' + escapeHtml(preview.status === 'unknown' ? 'partial' : preview.status) + '">' + escapeHtml(statusText) + '</span></div>' +
    '<p class="model-tree-order-note">模型系列按厂商产品线顺序展示；工具和套餐单独列出。</p>' +
    renderGroupSections(level2, detailsById) + '</section>' +
    '<section class="vendor-features"><h4>特点</h4>' + (preview.features || []).map(feature =>
      '<p class="vendor-feature ' + (feature.tone === 'negative' ? 'negative' : 'positive') + '">' + escapeHtml(feature.text) + '</p>'
    ).join('') + '</section>' +
  '</section>';
}

export default renderVendorLevel1;
