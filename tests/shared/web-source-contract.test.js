'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalizeUrl,
  hostMatchesDomain,
  normalizeSources,
  filterSourcesByDomains,
} = require('../../src/shared/web-source-contract');

test('web source contract canonicalizes URLs and matches exact/subdomains', () => {
  assert.equal(canonicalizeUrl(' <https://Example.com/a#fragment>。'), 'https://example.com/a');
  assert.equal(hostMatchesDomain('docs.example.com', 'example.com'), true);
  assert.equal(hostMatchesDomain('badexample.com', 'example.com'), false);
});

test('web source contract normalizes, deduplicates, and filters sources', () => {
  const sources = normalizeSources([
    { link: 'https://docs.example.com/a', title: 'A', content: 'one' },
    { url: 'https://docs.example.com/a#x', title: 'duplicate' },
    { url: 'https://other.example.net/b', title: 'B', excerpt: 'two' },
  ]);
  assert.equal(sources.length, 2);
  assert.deepEqual(filterSourcesByDomains(sources, ['example.com'], ['other.example.net']).map(item => item.url), ['https://docs.example.com/a']);
});
