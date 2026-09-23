'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let brandIcons;
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/web/icons/manifest.json'), 'utf8'));

test.before(async () => {
  const originalFetch = global.fetch;
  global.fetch = async url => String(url) === 'icons/manifest.json'
    ? { ok: true, json: async () => manifest }
    : { ok: false };
  brandIcons = await import('../../src/web/js/ui/brand-icons.js');
  await brandIcons.loadIcons();
  global.fetch = originalFetch;
});

test('Jev resolves the local TypeSafe vendor icon through vendor inheritance', () => {
  const resolved = brandIcons.resolveBrandIcon({ vendorKey: 'typesafe', toolKey: 'jev', seriesKey: 'jev', modelKey: 'jev' });
  assert.equal(resolved.bucket, 'vendor');
  assert.equal(resolved.key, 'typesafe');
  assert.equal(resolved.path, 'icons/vendor/typesafe.png');
  assert.equal(fs.existsSync(path.join(__dirname, '../../src/web/icons/vendor/typesafe.png')), true);
});
