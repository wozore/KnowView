'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectGithubRelease,
  collectGithubFile,
  collectDirectSource,
  collectUpdateEvidence,
  collectProductUpdateEvidence,
  fileTargetFromSource,
} = require('../../src/catalog/tool-update/index');

const NOW = '2026-08-25T12:00:00.000Z';

function response(payload, { status = 200, headers = {}, url = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: name => headers[name.toLowerCase()] || headers[name] || null },
    json: async () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function releaseSource(overrides = {}) {
  return {
    kind: 'github_releases',
    url: 'https://github.com/acme/tool/releases',
    collector: 'github_web_release',
    product_surface: 'cli',
    repository: 'acme/tool',
    include_prerelease: false,
    review_mode: 'deterministic',
    ...overrides,
  };
}

function fileSource(overrides = {}) {
  return {
    kind: 'github_file',
    url: 'https://github.com/acme/tool/blob/main/CHANGELOG.md',
    collector: 'github_web_file',
    product_surface: 'cli',
    repository: 'acme/tool',
    review_mode: 'deterministic',
    ...overrides,
  };
}

function directSource(overrides = {}) {
  return {
    kind: 'changelog',
    url: 'https://acme.example/changelog',
    collector: 'direct_fetch',
    product_surface: 'product',
    review_mode: 'deterministic',
    ...overrides,
  };
}

test('GitHub Release 构造公开 REST 请求并选择最新稳定 Release', async () => {
  const calls = [];
  const result = await collectGithubRelease('sample-tool', releaseSource({ tag_prefix: 'v' }), {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response([
        {
          name: 'Nightly', tag_name: 'v2.0.0-nightly', published_at: '2026-08-25T10:00:00Z',
          draft: false, prerelease: true, html_url: 'https://github.com/acme/tool/releases/tag/v2.0.0-nightly', body: 'nightly',
        },
        {
          name: 'Draft', tag_name: 'v1.9.0', published_at: '2026-08-25T09:00:00Z',
          draft: true, prerelease: false, html_url: 'https://github.com/acme/tool/releases/tag/v1.9.0', body: 'draft',
        },
        {
          name: 'Stable 1.8', tag_name: 'v1.8.0', published_at: '2026-08-24T09:00:00Z',
          draft: false, prerelease: false, html_url: 'https://github.com/acme/tool/releases/tag/v1.8.0', body: 'stable release body',
        },
      ]);
    },
    now: NOW,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/tool/releases?per_page=100');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers.Accept, 'application/vnd.github+json');
  assert.equal(result.evidence.url, 'https://github.com/acme/tool/releases/tag/v1.8.0');
  assert.equal(result.evidence.official_published_at, '2026-08-24T09:00:00Z');
  assert.equal(result.evidence.status, 'ready');
  assert.equal(result.evidence.collected_at, NOW);
  assert.match(result.evidence.content_hash, /^sha256:[0-9a-f]{64}$/);
});

test('GitHub Release draft/prerelease 无候选时 fail-closed', async () => {
  const result = await collectGithubRelease('sample-tool', releaseSource(), {
    fetchImpl: async () => response([
      { tag_name: 'v2.0.0', published_at: '2026-08-25T10:00:00Z', draft: true, prerelease: false, html_url: 'https://github.com/acme/tool/releases/tag/v2.0.0', body: 'draft' },
      { tag_name: 'v1.0.0', published_at: '2026-08-25T09:00:00Z', draft: false, prerelease: true, html_url: 'https://github.com/acme/tool/releases/tag/v1.0.0', body: 'preview' },
    ]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GITHUB_RELEASE_NO_ELIGIBLE');
});

test('GitHub Release 缺 published_at 只返回 discovery_only，不伪造日期', async () => {
  const result = await collectGithubRelease('sample-tool', releaseSource(), {
    fetchImpl: async () => response([{
      name: 'Stable without metadata', tag_name: 'v1.0.0', draft: false, prerelease: false,
      html_url: 'https://github.com/acme/tool/releases/tag/v1.0.0', body: 'release body',
    }]),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.status, 'discovery_only');
  assert.equal(result.evidence.official_published_at, null);
  assert.equal(result.evidence.diagnostics.reason, 'published_at_missing_or_invalid');
});

test('GitHub Release 正文为空但有官方 published_at 时仍生成 ready 证据', async () => {
  const result = await collectGithubRelease('sample-tool', releaseSource({ tag_prefix: 'v' }), {
    fetchImpl: async () => response([{
      name: 'v2.0.0', tag_name: 'v2.0.0', published_at: '2026-08-24T00:28:28Z',
      draft: false, prerelease: false, html_url: 'https://github.com/acme/tool/releases/tag/v2.0.0', body: '',
    }]),
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.evidence.status, 'ready');
  assert.equal(result.evidence.official_published_at, '2026-08-24T00:28:28Z');
  assert.equal(result.evidence.diagnostics.body_empty, true);
  assert.equal(result.evidence.excerpt, 'v2.0.0');
});

test('GitHub 429 最多有限重试并保留限流诊断，不绕过公开 API 限额', async () => {
  let attempts = 0;
  const result = await collectGithubRelease('sample-tool', releaseSource(), {
    retries: 1,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return response('rate limited', { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1788000000' } });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GITHUB_RATE_LIMITED');
  assert.equal(result.attempts, 2);
  assert.equal(result.rate_limit_remaining, '0');
  assert.equal(attempts, 2);
});

test('GitHub Release html_url 不对应登记仓库时拒绝证据', async () => {
  const result = await collectGithubRelease('sample-tool', releaseSource(), {
    fetchImpl: async () => response([{
      name: 'Wrong repo', tag_name: 'v1.0.0', published_at: '2026-08-25T10:00:00Z',
      draft: false, prerelease: false, html_url: 'https://github.com/other/tool/releases/tag/v1.0.0', body: 'body',
    }]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'GITHUB_RELEASE_HTML_URL_INVALID');
});

test('GitHub file 从 blob 人工 URL 派生 raw URL，保留人工 URL 为证据 URL', async () => {
  const calls = [];
  const source = fileSource();
  assert.deepEqual(fileTargetFromSource(source), {
    repository: 'acme/tool',
    ref: 'main',
    filePath: 'CHANGELOG.md',
    url: source.url,
  });
  const result = await collectGithubFile('sample-tool', source, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response('# Changelog\n\n## 1.0.0\n\n- Initial release');
    },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'https://raw.githubusercontent.com/acme/tool/main/CHANGELOG.md');
  assert.equal(calls[0].init.headers.Accept, 'text/plain, text/markdown, */*');
  assert.equal(result.evidence.url, source.url);
  assert.equal(result.evidence.official_published_at, null);
  assert.equal(result.evidence.status, 'ready');
});

test('GitHub file Tags 页面、路径穿越和非法 ref 均拒绝且不发请求', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response('unexpected'); };
  const tags = await collectGithubFile('sample-tool', fileSource({ url: 'https://github.com/acme/tool/tags' }), { fetchImpl });
  const traversal = await collectGithubFile('sample-tool', fileSource({ url: 'https://github.com/acme/tool/blob/main/../secret.txt' }), { fetchImpl });
  const invalidRef = await collectGithubFile('sample-tool', fileSource({ url: 'https://github.com/acme/tool/blob/main%2Ffeature/CHANGELOG.md' }), { fetchImpl });
  assert.equal(tags.code, 'GITHUB_FILE_TARGET_INVALID');
  assert.equal(traversal.code, 'GITHUB_FILE_TARGET_INVALID');
  assert.equal(invalidRef.code, 'GITHUB_FILE_TARGET_INVALID');
  assert.equal(calls, 0);
});

test('direct collector 从官方 HTML 提取带日期的更新证据', async () => {
  const calls = [];
  const source = directSource();
  const result = await collectDirectSource('sample-tool', source, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response('# Official changelog\n\n## Aug 21, 2026\n\n- New feature');
    },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, source.url);
  assert.equal(result.evidence.url, source.url);
  assert.equal(result.evidence.official_published_at, null);
  assert.equal(result.evidence.diagnostics.collector, 'direct_fetch');
  assert.match(result.evidence.excerpt, /Aug 21, 2026/);
});

test('direct HTML 跨产品重定向直接失败，不采纳错误产品正文', async () => {
  const source = directSource({ url: 'https://windsurf.example/changelog' });
  const result = await collectDirectSource('windsurf', source, {
    fetchImpl: async () => response('# Devin Desktop changelog\\n\\n## Aug 21, 2026', { url: 'https://docs.devin.ai/release-notes/overview' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UPDATE_HTML_REDIRECT_UNTRUSTED');
  assert.equal(result.final_url, 'https://docs.devin.ai/release-notes/overview');
});
test('HTML 抓取失败或没有日期时返回失败，不调用备用提取服务', async () => {
  const calls = [];
  const source = directSource();
  const result = await collectDirectSource('sample-tool', source, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init, ...(init && init.body ? { body: JSON.parse(init.body) } : {}) });
      return response('<html><body>No dated update here</body></html>');
    },
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UPDATE_HTML_DATES_UNAVAILABLE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, source.url);
});

test('统一入口拒绝非法 source，产品批量入口保留逐源失败隔离', async () => {
  const registry = {
    schema_version: 1,
    products: {
      sample: { update_sources: [directSource(), { ...directSource(), url: 'http://bad.example/changelog' }] },
    },
  };
  const single = await collectUpdateEvidence('sample', { ...directSource(), repository: 'not-allowed' }, {
    fetchImpl: async () => { throw new Error('不应请求'); },
  });
  assert.equal(single.ok, false);
  assert.equal(single.code, 'UPDATE_SOURCE_INVALID');

  let calls = 0;
  const batch = await collectProductUpdateEvidence('sample', {
    registry,
    fetchImpl: async (url) => {
      calls += 1;
      return response('<html><body></body></html>');
    },
  });
  assert.equal(batch.ok, false);
  assert.equal(batch.evidence.length, 0);
  assert.equal(batch.failed.length, 2);
  assert.equal(calls, 1, '合法来源只发起一次 HTTP 正文直连，非法 HTTP 来源不发请求');
});
