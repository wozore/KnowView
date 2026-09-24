'use strict';

const fs = require('fs');
const { AI_CONFIG_FILES } = require('../shared/paths');
const { getProvider, DEFAULT_PROVIDER_NAME } = require('../shared/providers');

// 默认外部 provider 开关（统一收口在 registry 的 DEFAULT_PROVIDER_NAME）。
// config/catalog-generator.local.json 可按模块覆盖 provider/model/protocol。
const DEFAULT_PROVIDER = getProvider(DEFAULT_PROVIDER_NAME);

const DEFAULT_MODULE_CONFIGS = Object.freeze({
  catalog: Object.freeze({
    enabled: true,
    provider: DEFAULT_PROVIDER_NAME,
    search_provider: 'zhipu_web_search',
    search_fallback_provider: 'tavily',
    extract_provider: 'direct_fetch',
    extract_fallback_provider: 'tavily',
    search_engine: 'search_std',
    model: DEFAULT_PROVIDER.defaultModel,
    protocol: DEFAULT_PROVIDER.protocol,
    timeout_ms: 180000,
    max_search_queries: 4,
    max_pages: 8,
    max_responses_calls: 12,
    max_synthesis_calls: 1,
    max_repair_calls: 1,
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readAiConfig(filePath = AI_CONFIG_FILES.local) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { modules: {} };
    throw error;
  }
}

function validateModuleConfig(moduleName, config) {
  const provider = getProvider(config.provider);
  if (!provider) {
    throw Object.assign(new Error(`模块 ${moduleName} 使用了不支持的 AI provider: ${config.provider}`), {
      code: 'AI_PROVIDER_UNSUPPORTED',
    });
  }
  if (config.protocol !== provider.protocol) {
    throw Object.assign(new Error(`模块 ${moduleName} 的 protocol=${config.protocol} 与 provider=${config.provider} 不匹配`), {
      code: 'AI_PROTOCOL_MISMATCH',
    });
  }
  if (moduleName === 'catalog') {
    if (Object.prototype.hasOwnProperty.call(config, 'retrieval_provider')) {
      throw Object.assign(new Error(`模块 ${moduleName} 不再支持 retrieval_provider，请改用 search_provider/extract_provider`), {
        code: 'RETRIEVAL_PROVIDER_UNSUPPORTED',
      });
    }
    if (!['tavily', 'zhipu_web_search'].includes(config.search_provider)) {
      throw Object.assign(new Error(`模块 ${moduleName} 的 search_provider 不受支持: ${config.search_provider}`), { code: 'SEARCH_PROVIDER_UNSUPPORTED' });
    }
    if (!['tavily', 'zhipu_web_search'].includes(config.search_fallback_provider)) {
      throw Object.assign(new Error(`模块 ${moduleName} 的 search_fallback_provider 不受支持: ${config.search_fallback_provider}`), { code: 'SEARCH_FALLBACK_PROVIDER_UNSUPPORTED' });
    }
    if (config.extract_provider !== 'direct_fetch') {
      throw Object.assign(new Error(`模块 ${moduleName} 的 extract_provider 不受支持: ${config.extract_provider}`), { code: 'EXTRACT_PROVIDER_UNSUPPORTED' });
    }
    if (config.extract_fallback_provider !== 'tavily') {
      throw Object.assign(new Error(`模块 ${moduleName} 的 extract_fallback_provider 不受支持: ${config.extract_fallback_provider}`), { code: 'EXTRACT_FALLBACK_PROVIDER_UNSUPPORTED' });
    }
    if (!['search_std', 'search_pro', 'search_pro_sogou', 'search_pro_quark'].includes(config.search_engine)) {
      throw Object.assign(new Error(`模块 ${moduleName} 的 search_engine 不受支持: ${config.search_engine}`), { code: 'SEARCH_ENGINE_UNSUPPORTED' });
    }
  }
  return config;
}

function loadAiModuleConfig(moduleName, filePath = AI_CONFIG_FILES.local) {
  const defaults = clone(DEFAULT_MODULE_CONFIGS[moduleName] || {
    enabled: false,
    provider: DEFAULT_PROVIDER_NAME,
    protocol: DEFAULT_PROVIDER.protocol,
  });
  const raw = readAiConfig(filePath);
  const configured = raw?.modules?.[moduleName];
  const config = {
    ...defaults,
    ...(configured && typeof configured === 'object' ? configured : {}),
  };
  const provider = getProvider(config.provider);
  if (config.protocol === undefined && provider) config.protocol = provider.protocol;
  return validateModuleConfig(moduleName, config);
}

module.exports = {
  DEFAULT_MODULE_CONFIGS,
  readAiConfig,
  loadAiModuleConfig,
  validateModuleConfig,
};
