'use strict';

/**
 * refresh-vibe-hub-cache.js —— VibeHub 概念缓存刷新入口（当前联网功能关闭）
 */

const { loadDotEnv } = require('../src/shared/env');
const { EXTERNAL_NETWORK_ENABLED, externalNetworkDisabledResult } = require('../src/shared/external-operation-policy');

const {
  loadVibeHubCache,
  saveVibeHubCache,
  refreshStaleVibeHubCache,
} = require('../src/catalog/concept/index');

async function main(argv = [], options = {}) {
  if (!EXTERNAL_NETWORK_ENABLED) {
    const report = { ...externalNetworkDisabledResult('EXTERNAL_NETWORK_DISABLED'), status: 'disabled' };
    if (!options.silent) console.log(JSON.stringify(report, null, 2));
    return report;
  }
  loadDotEnv();
  const cache = loadVibeHubCache(options);
  const entryCount = Object.keys(cache.entries || {}).length;
  if (!entryCount) {
    const report = { ok: true, cache_missing: true, message: 'vibe-hub 缓存为空，跳过刷新（零网络）' };
    if (!options.silent) console.log(JSON.stringify(report, null, 2));
    return report;
  }
  const report = await refreshStaleVibeHubCache(cache, options);
  if (report.refreshed.length || report.failed.length) saveVibeHubCache(cache, options);
  const out = { ok: report.failed.length === 0, cache_entries: entryCount, ...report };
  if (!options.silent) console.log(JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
