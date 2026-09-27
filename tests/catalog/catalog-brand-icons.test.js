'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { auditNewCatalogBrandIcons } = require('../../src/catalog/catalog-brand-icons');

function snapshot() {
  return { 'vendor-card': [], 'tool-card': [], 'vendor-level2': [] };
}

function options(manifest) {
  return { manifest, assetExists: () => true };
}

test('new vendor cards require a registered, existing vendor icon', () => {
  const before = snapshot();
  const after = snapshot();
  after['vendor-card'].push({ id: 'vendor-card:brand', vendor_key: 'brand', title: 'Brand' });
  const missing = auditNewCatalogBrandIcons(before, after, options({ vendor: {} }));
  assert.equal(missing.ok, false);
  assert.equal(missing.issues[0].code, 'CATALOG_BRAND_ICON_MISSING');
  const covered = auditNewCatalogBrandIcons(before, after, options({ vendor: { brand: 'vendor/brand.svg' } }));
  assert.equal(covered.ok, true);
});

test('new tool cards accept a resolvable vendor or series icon', () => {
  const before = snapshot();
  const after = snapshot();
  after['vendor-level2'].push({ id: 'vendor-level2:brand:models', vendor_key: 'brand', detail_refs: [{ id: 'tool-level3:member' }] });
  after['tool-card'].push({ id: 'tool-card:member', tool_key: 'member', vendor_key: 'brand', detail_ref: { id: 'tool-level3:member' }, detail_kind: 'tool' });
  assert.equal(auditNewCatalogBrandIcons(before, after, options({ vendor: { brand: 'vendor/brand.svg' } })).ok, true);
  assert.equal(auditNewCatalogBrandIcons(before, after, options({ series: { models: 'series/models.svg' } })).ok, true);
  const missing = auditNewCatalogBrandIcons(before, after, options({ vendor: {}, series: {}, tool: {}, model: {} }));
  assert.equal(missing.ok, false);
  assert.equal(missing.issues[0].code, 'CATALOG_BRAND_ICON_MISSING');
});

test('unchanged legacy cards do not block later catalog changes', () => {
  const legacy = { id: 'tool-card:legacy', tool_key: 'legacy', vendor_key: 'old-brand', detail_ref: { id: 'tool-level3:legacy' }, detail_kind: 'tool' };
  const before = { ...snapshot(), 'tool-card': [legacy] };
  const after = { ...snapshot(), 'tool-card': [{ ...legacy, summary: 'Updated' }] };
  assert.deepEqual(auditNewCatalogBrandIcons(before, after, options({ vendor: {}, tool: {}, series: {}, model: {} })), { ok: true, issues: [] });
});

test('a registered but missing asset blocks new cards', () => {
  const before = snapshot();
  const after = snapshot();
  after['vendor-card'].push({ id: 'vendor-card:brand', vendor_key: 'brand', title: 'Brand' });
  const result = auditNewCatalogBrandIcons(before, after, { manifest: { vendor: { brand: 'vendor/missing.svg' } }, assetExists: () => false });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'CATALOG_BRAND_ICON_FILE_MISSING');
});
