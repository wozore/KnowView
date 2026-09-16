'use strict';

function normalizeToolToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9一-龥]+/g, '');
}

const VAGUE_FAMILY_NAMES = new Set([
  '通义千问', '腾讯混元', '豆包', 'kimi', '天工ai', '可灵',
  'chatgpt', 'claude', 'gemini', 'deepseek', '智谱清言', '智谱',
  '文心一言', '讯飞星火', '海螺ai', 'grok', 'mistral', 'cohere',
]);

function isVagueName(name) {
  return VAGUE_FAMILY_NAMES.has(String(name || '').trim().toLowerCase());
}

// 身份判定：归一化后精确同一才判"确实是同一个工具/型号"。
// 不再做双向子串/vendor 包含等模糊裁决（Gemini 3.8 Live 被 Gemini 3.8 家族卡
// 静默吸附的事故）；模糊命中改由 findSimilarTools 以提示返回，交人工确认。
function toolExists(toolName, tools) {
  const needleNorm = normalizeToolToken(toolName);
  if (!needleNorm) return false;
  return (tools || []).some(tool => {
    const title = String(tool.title || tool.name || '');
    const key = String(tool.tool_key || tool.id || '');
    return (title && normalizeToolToken(title) === needleNorm)
      || (key && normalizeToolToken(key) === needleNorm);
  });
}

// 旧 toolExists 的模糊匹配逻辑（title/key 双向子串 + vendor 包含）整体搬迁至此：
// 只产出"疑似近似卡"提示，不做收录裁决。按原顺序去重、不截断数量（调用方截断）。
function findSimilarTools(toolName, tools) {
  const needle = String(toolName || '').toLowerCase();
  if (!needle) return [];
  const seen = new Set();
  const similar = [];
  for (const tool of tools || []) {
    const title = String(tool.title || tool.name || '');
    const key = String(tool.tool_key || tool.id || '');
    const vendor = String(tool.vendor_label || tool.vendor_name || '').toLowerCase();
    const titleLower = title.toLowerCase();
    const keyLower = key.toLowerCase();
    const hit = (title && titleLower.includes(needle)) || (key && keyLower.includes(needle))
      || (vendor && vendor.includes(needle)) || (needle.includes(titleLower) && title)
      || (needle.includes(keyLower) && key);
    if (!hit) continue;
    const dedupeKey = `${normalizeToolToken(key)}|${normalizeToolToken(title)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    similar.push({
      tool_key: tool.tool_key ?? null,
      title: tool.title ?? null,
      vendor_label: tool.vendor_label ?? null,
    });
  }
  return similar;
}

function conceptExists(conceptName, glossary) {
  const needle = String(conceptName || '').toLowerCase();
  if (!needle) return false;
  return (glossary || []).some(entry => {
    const term = String(entry.term || '').toLowerCase();
    const fullName = String(entry.full_name || '').toLowerCase();
    return (term && term.includes(needle)) || (fullName && fullName.includes(needle))
      || (needle.includes(term) && term) || (needle.includes(fullName) && fullName);
  });
}

module.exports = { isVagueName, toolExists, findSimilarTools, conceptExists };
