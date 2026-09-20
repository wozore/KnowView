'use strict';

/**
 * extract-strategy.js —— 实体提取统一策略装配
 *
 * 统一 CLI（cmd-min）与工作台（catalog-domain / maintainer-workbench-service）
 * 的实体提取策略：
 * 1. 当 config.feedback.llm_extract !== false 时，统一调用类型化提取器（extractEntitiesWithLlm）。
 * 2. 本地模型端点（LOCAL_API_BASE）可用时，不得以缺失外部 key 为由降级正则。
 * 3. 提取失败由外层安全降级至默认正则，并记录 diagnostics 与 warnings。
 * 4. 识别单独出现的厂商/平台/系列泛称（OpenAI, Anthropic, Cerebras, Runway, Qwen,
 *    Claude, ChatGPT, GPT, DeepSeek, GLM, Mistral, Gemini, 豆包等），标记为 vague/filtered；
 *    当同一摘要出现具体产品/系列/型号（Claude Code, Claude Opus 4.8, GPT-5.6,
 *    Gemini 3.8 Live, Grok Voice Transcribe 2.0）时，保留完整实体。
 */

const { extractEntitiesWithLlm } = require('./llm-entity-extract');

const VAGUE_VENDOR_NAMES = new Set([
  'openai', 'anthropic', 'cerebras', 'runway', 'qwen', 'claude',
  'chatgpt', 'gpt', 'deepseek', 'glm', 'mistral', 'gemini', '豆包',
  '通义千问', '腾讯混元', 'kimi', '智谱', '智谱清言', '文心一言', '讯飞星火', '海螺ai', 'grok', 'xai',
]);

function isVagueVendor(name) {
  const norm = String(name || '').trim().toLowerCase();
  return VAGUE_VENDOR_NAMES.has(norm);
}

function createExtractDiagnostics() {
  return {
    no_entities: [],
    llm_failed: [],
    format_invalid: [],
    fallback: [],
    vague_filtered: [],
    exact_match_filtered: [],
    warnings: [],
  };
}

/**
 * 规范化提取实体，确保厂商泛称单独出现时标记为 vague。
 */
function normalizeExtractedEntities(entities, diagnostics = null) {
  const list = Array.isArray(entities) ? entities : [];
  const normalized = [];
  for (const item of list) {
    if (!item) continue;
    const name = String(item.name || item).trim();
    if (!name) continue;
    let type = item.type || 'tool';
    if (isVagueVendor(name)) {
      type = 'vague';
    }
    normalized.push({ name, type });
  }
  return normalized;
}

/**
 * 创建统一实体提取函数。
 * @param {object} [config] news-config 配置（含 feedback: { llm_extract, llm_model }）
 * @param {object} [options] 依赖注入项 { catalogApi, ledger, llmExtract, defaultExtract, fetchImpl, endpoint, apiKey, model, timeoutMs }
 * @param {object} [diagnostics] 诊断容器
 * @returns {(text: string) => Promise<Array<{name: string, type: string}>>}
 */
function createUnifiedExtractor(config = {}, options = {}, diagnostics = null) {
  const feedback = (config && config.feedback) || {};
  const shouldLlmExtract = feedback.llm_extract !== false;

  return async function extract(text) {
    const rawText = String(text || '').trim();
    if (!rawText) return [];

    // 1. 若调用方显式注入了 llmExtract（如单元测试），优先直接调用
    if (typeof options.llmExtract === 'function') {
      try {
        const result = await options.llmExtract(rawText);
        const normalized = normalizeExtractedEntities(result, diagnostics);
        if (normalized.length === 0 && diagnostics) {
          diagnostics.no_entities.push({ text: rawText.slice(0, 100) });
        }
        return normalized;
      } catch (error) {
        if (diagnostics) {
          diagnostics.llm_failed.push({ error: error.message, code: error.code || 'EXTRACT_FAILED', text: rawText.slice(0, 100) });
          diagnostics.fallback.push({ text: rawText.slice(0, 100), reason: error.message });
          diagnostics.warnings.push(`注入 LLM 提取失败已降级: ${error.message}`);
        }
        if (typeof options.defaultExtract === 'function') {
          return normalizeExtractedEntities(await options.defaultExtract(rawText), diagnostics);
        }
        return [];
      }
    }

    // 2. 配置开启 LLM 提取且具备 ledger 或 catalogApi
    if (shouldLlmExtract) {
      if (!options.ledger && !options.catalogApi) {
        if (feedback.llm_extract === true && diagnostics && !diagnostics.warnings.includes('LLM_EXTRACT_SKIPPED_MISSING_LEDGER_OR_CATALOG_API')) {
          diagnostics.warnings.push('LLM_EXTRACT_SKIPPED_MISSING_LEDGER_OR_CATALOG_API');
        }
      } else {
        try {
          const result = await extractEntitiesWithLlm(rawText, {
            catalogApi: options.catalogApi,
            ledger: options.ledger,
            model: options.model || feedback.llm_model,
            endpoint: options.endpoint,
            apiKey: options.apiKey,
            fetchImpl: options.fetchImpl,
            timeoutMs: options.timeoutMs,
          });
          const normalized = normalizeExtractedEntities(result, diagnostics);
          if (normalized.length === 0 && diagnostics) {
            diagnostics.no_entities.push({ text: rawText.slice(0, 100) });
          }
          return normalized;
        } catch (error) {
          if (diagnostics) {
            const isFormatInvalid = error.code === 'ENTITY_EXTRACT_INVALID' || error.message.includes('invalid');
            if (isFormatInvalid) {
              diagnostics.format_invalid.push({ error: error.message, text: rawText.slice(0, 100) });
            }
            diagnostics.llm_failed.push({ error: error.message, code: error.code || 'LLM_EXTRACT_FAILED', text: rawText.slice(0, 100) });
            diagnostics.fallback.push({ text: rawText.slice(0, 100), reason: error.message });
            diagnostics.warnings.push(`LLM 实体提取失败已降级正则: ${error.message}`);
          }
          if (typeof options.defaultExtract === 'function') {
            return normalizeExtractedEntities(await options.defaultExtract(rawText), diagnostics);
          }
          return [];
        }
      }
    }

    // 3. 默认正则提取路径：不做硬名单 vague 拦截，宁多生成交人工确认
    if (typeof options.defaultExtract === 'function') {
      const result = await options.defaultExtract(rawText);
      const list = Array.isArray(result) ? result : [];
      const normalized = list.map(item => {
        const name = String(item.name || item).trim();
        const type = item.type || 'tool';
        return { name, type };
      }).filter(item => item.name);
      if (normalized.length === 0 && diagnostics) {
        diagnostics.no_entities.push({ text: rawText.slice(0, 100) });
      }
      return normalized;
    }

    return [];
  };
}

module.exports = {
  VAGUE_VENDOR_NAMES,
  isVagueVendor,
  createExtractDiagnostics,
  normalizeExtractedEntities,
  createUnifiedExtractor,
};
