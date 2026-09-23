'use strict';

/**
 * extract-strategy.js —— 实体提取统一策略装配
 *
 * 统一 CLI（cmd-min）与工作台（catalog-domain / maintainer-workbench-service）
 * 的实体提取策略：
 * 1. 当 config.feedback.llm_extract !== false 时，统一调用类型化提取器（extractEntitiesWithLlm）。
 * 2. 统一网关改走 GLM；缺少外部 key 时记录失败并降级正则。
 * 3. 提取失败由外层安全降级至默认正则，并记录 diagnostics 与 warnings。
 * 4. 识别单独出现的厂商/平台/系列泛称（OpenAI, Anthropic, Cerebras, Runway, Qwen,
 *    Claude, ChatGPT, GPT, DeepSeek, GLM, Mistral, Gemini, 豆包等），标记为 vague/filtered；
 *    当同一摘要出现具体产品/系列/型号（Claude Code, Claude Opus 4.8, GPT-5.6,
 *    Gemini 3.8 Live, Grok Voice Transcribe 2.0）时，保留完整实体。
 */

const { extractEntitiesWithLlm, admissionReviewWithLlm } = require('./llm-entity-extract');

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

/**
 * 第 2 轮 AI：批量准入筛查与归一化。
 *
 * 显式注入 llmExtract 的调用方（单测替身/自控提取）不叠加密筛；
 * 生产路径（CLI/工作台，未注入 llmExtract）经 catalogApi 成本记账走准入筛查。
 * 筛查失败或依赖缺失时 fail-open 回退第一轮结果，但必须写入 diagnostics.warnings。
 *
 * @param {object} args { allEntities, texts, feedback, options, diagnostics }
 * @returns {Map<string, {name, type, count}>} 筛查后的实体集（原 Map 直接复用或重建）
 */
async function applyAdmissionScreening({ allEntities, texts, feedback, options, diagnostics }) {
  const shouldLlmExtract = feedback.llm_extract !== false;
  const injectedExtractor = typeof options.llmExtract === 'function';
  const admissionDeps = !injectedExtractor && (options.ledger
    || (options.catalogApi && typeof options.catalogApi.createEntityLedger === 'function'));
  const hasReviewFn = typeof options.admissionReview === 'function';
  if (!shouldLlmExtract || allEntities.size === 0 || (!admissionDeps && !hasReviewFn)) {
    if (shouldLlmExtract && allEntities.size > 0 && !injectedExtractor) {
      diagnostics.warnings.push('LLM_ADMISSION_REVIEW_SKIPPED_MISSING_LEDGER_OR_CATALOG_API');
    }
    return allEntities;
  }

  try {
    const entitiesArray = Array.from(allEntities.values()).map(e => ({
      name: e.name,
      type: e.type,
      summaries: texts.filter(t => t.includes(e.name)).slice(0, 3), // 每个实体最多附 3 条来源摘要
    }));

    // 分批送审：批过大触发 max_output_tokens 截断（INCOMPLETE）；15 项/批 × 2000 token 上限
    // 批级失败只回退该批实体（保留第一轮结果），其余批次照常裁决
    const reviewFn = hasReviewFn ? options.admissionReview : admissionReviewWithLlm;
    const BATCH_SIZE = 15;
    const reviewOptions = {
      catalogApi: options.catalogApi,
      ledger: options.ledger,
      model: options.model || feedback.llm_model,
      endpoint: options.endpoint,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    };
    const admissionResults = [];
    const failedBatchEntities = [];
    for (let i = 0; i < entitiesArray.length; i += BATCH_SIZE) {
      const batch = entitiesArray.slice(i, i + BATCH_SIZE);
      try {
        const reviewed = await reviewFn(batch, reviewOptions);
        admissionResults.push(...reviewed);
      } catch (error) {
        diagnostics.warnings.push(`准入筛查批次失败（${batch.length} 个实体保留第一轮结果）: ${error.message}`);
        failedBatchEntities.push(...batch);
      }
    }

    const screened = new Map();
    for (const entity of failedBatchEntities) {
      screened.set(entity.name, { name: entity.name, type: entity.type, count: allEntities.get(entity.name).count });
    }
    for (const res of admissionResults) {
      if (res.decision === 'reject') {
        diagnostics.vague_filtered.push({ name: res.original_name, type: 'rejected_by_admission', reason: res.reason });
        continue;
      }
      const original = allEntities.get(res.original_name);
      if (!original) continue;
      const finalName = res.decision === 'merge' && res.final_name ? res.final_name : res.original_name;
      const existing = screened.get(finalName);
      if (existing) existing.count += original.count;
      else screened.set(finalName, { name: finalName, type: original.type, count: original.count });
    }
    return screened;
  } catch (error) {
    diagnostics.warnings.push(`LLM 准入筛查失败，降级使用第一轮结果: ${error.message}`);
    return allEntities;
  }
}

module.exports = {
  VAGUE_VENDOR_NAMES,
  isVagueVendor,
  createExtractDiagnostics,
  normalizeExtractedEntities,
  createUnifiedExtractor,
  applyAdmissionScreening,
};
