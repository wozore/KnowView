'use strict';

/** catalog-brand-icons.js — 对新增目录卡片校验前端品牌图标覆盖。 */

const fs = require('fs');
const path = require('path');
const { CATALOG_BRAND_ICON_FILES } = require('../shared/paths');

const SAFE_ASSET_PATH = /^[a-zA-Z0-9._/-]+$/;

function changedCards(before, after, area, fields) {
  const previous = new Map((before?.[area] || []).map(item => [item.id, item]));
  return (after?.[area] || []).filter(item => {
    const old = previous.get(item.id);
    return !old || fields.some(field => JSON.stringify(old[field]) !== JSON.stringify(item[field]));
  });
}

function entryPath(entry) {
  const value = typeof entry === 'string' ? entry : entry?.path;
  return typeof value === 'string' && SAFE_ASSET_PATH.test(value)
    && !value.startsWith('/') && !value.includes('..') ? value : null;
}

function assetIsFile(asset, fsImpl, assetRoot, assetExists) {
  try {
    return assetExists
      ? assetExists(asset) === true
      : fsImpl.statSync(path.join(assetRoot, asset)).isFile();
  } catch { return false; }
}

function seriesKeyOf(snapshot, card) {
  const detailId = card.detail_ref?.id;
  const group = (snapshot?.['vendor-level2'] || []).find(item => item.vendor_key === card.vendor_key
    && (item.detail_refs || []).some(ref => ref.id === detailId));
  return group?.id?.split(':').pop() || null;
}

function displayIcon({ snapshot, card, manifest, assetExists }) {
  const detailSlug = card.detail_kind === 'api_model' ? card.detail_ref?.id?.split(':').pop() : null;
  const candidates = [
    ['model', detailSlug],
    ['series', seriesKeyOf(snapshot, card)],
    ['tool', card.tool_key],
    ['vendor', card.vendor_key],
  ];
  for (const [bucket, key] of candidates) {
    if (!key) continue;
    const asset = entryPath(manifest?.[bucket]?.[key]);
    if (asset) return { bucket, key, asset, exists: assetExists(asset) };
  }
  return null;
}

function readManifest(options, fsImpl) {
  if (options.manifest && typeof options.manifest === 'object') return options.manifest;
  const manifestPath = options.manifestPath || CATALOG_BRAND_ICON_FILES.manifest;
  return JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
}

function auditNewCatalogBrandIcons(before, after, options = {}) {
  const vendors = changedCards(before, after, 'vendor-card', ['vendor_key']);
  const tools = changedCards(before, after, 'tool-card', ['tool_key', 'vendor_key', 'detail_ref', 'detail_kind', 'model_key']);
  if (!vendors.length && !tools.length) return { ok: true, issues: [] };

  const fsImpl = options.fsImpl || fs;
  const assetRoot = options.assetRoot || CATALOG_BRAND_ICON_FILES.assets;
  const assetExists = options.assetExists;
  let manifest;
  try { manifest = readManifest(options, fsImpl); }
  catch (error) {
    return { ok: false, issues: [{ code: 'CATALOG_BRAND_ICON_MANIFEST_INVALID', reason: error.message }] };
  }

  const issues = [];
  for (const card of vendors) {
    const asset = entryPath(manifest?.vendor?.[card.vendor_key]);
    if (!asset || !assetIsFile(asset, fsImpl, assetRoot, assetExists)) issues.push({
      code: asset ? 'CATALOG_BRAND_ICON_FILE_MISSING' : 'CATALOG_BRAND_ICON_MISSING',
      area: 'vendor-card', id: card.id, title: card.title, vendor_key: card.vendor_key,
      reason: asset ? `厂商 ${card.title} 登记的图标文件不存在：${asset}` : `厂商 ${card.title}（${card.vendor_key}）没有可用的品牌图标登记。`,
    });
  }
  for (const card of tools) {
    const resolved = displayIcon({ snapshot: after, card, manifest, assetExists: asset => assetIsFile(asset, fsImpl, assetRoot, assetExists) });
    if (!resolved || !resolved.exists) issues.push({
      code: resolved ? 'CATALOG_BRAND_ICON_FILE_MISSING' : 'CATALOG_BRAND_ICON_MISSING',
      area: 'tool-card', id: card.id, title: card.title, tool_key: card.tool_key, vendor_key: card.vendor_key,
      reason: resolved
        ? `${card.title} 命中的 ${resolved.bucket}.${resolved.key} 图标文件不存在：${resolved.asset}`
        : `工具 ${card.title} 没有可用的工具、系列或厂商图标。`,
    });
  }
  return { ok: issues.length === 0, issues };
}

module.exports = { auditNewCatalogBrandIcons };
