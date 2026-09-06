'use strict';

/**
 * llm-entity-extract.js —— 摘要 AI 实体提取（feedback 反哺的 LLM 提取器）
 *
 * 替代 tool-feedback 默认正则提取：让 DeepSeek 从摘要里找 AI 相关的
 * 工具 / 模型 / 概念，并输出类型（用户拍板：方案 A + 检查遗漏，不喂正则候选）。
 *
 * 输出类型 type ∈ tool / model / series / concept / vague：
 *   tool    具体工具（Cursor、Suno）→ 待补工具卡（detail_kind: tool）
 *   model   官方以独立可调用型号发布的具体模型 → 待补工具卡（detail_kind: api_model），交官方身份核验
 *   series  模型系列/版本代际/产品线（GPT-5.6、GLM-5.3）→ 待补工具卡（entity_type: series），走系列 Bundle 管线
 *   concept AI 概念（RAG、vibe coding）→ 待补概念卡
 *   vague   产品/平台/品牌笼统名（可灵、通义千问、豆包）→ 不生成待补卡
 *
 * vague 名除 LLM 判定外，由 tool-feedback 的 isVagueName 兜底拦截：
 * 即使 LLM 把笼统名误标为 tool，也绝不会进入待补工具卡。
 *
 * 复用 shared 的 requestStructuredJson（Responses 协议 + 结构化 JSON 外壳归一化 +
 * ledger fail-closed + 有限响应诊断）。成本账本与默认模型目录配置经
 * options.catalogApi = { createEntityLedger, resolveEntityModel } 注入（组合根构造），
 * 本模块不直读任何 catalog 域模块。
 *
 * 降级语义：LLM 调用失败（网络/限流/缺 key/输出非法）时【抛错】，由 cmd-min 的
 * 注入包装层捕获后回退正则提取（extractEntitiesDefault，宁多勿漏），不阻断反哺。
 * 成功但确实没有工具/概念 → 返回 []（AI 判断本段无内容），不回退正则。
 *
 * 注入点（测试用）：options.ledger / model / apiKey / fetchImpl / timeoutMs。
 */

const { requestStructuredJson } = require('../../shared/llm-gateway');
const { LOCAL_API_BASE } = require('../../shared/llm-endpoints');

const DEFAULT_MAX_OUTPUT_TOKENS = 600;

/** 实体类型枚举（tool-feedback 按此路由；vague 名不生成待补卡）。 */
const ENTITY_TYPES = Object.freeze(['tool', 'model', 'series', 'concept', 'vague']);

/** 提取 prompt（输出带类型 JSON 数组；分不清系列/具体模型时标 model 交官方核验）。 */
function buildEntityExtractInstructions() {
  return '这个摘要里好像有 AI 相关的工具、模型、概念什么的，请你找出来并判断类型。硬性规则：' +
    '1.只找摘要里真实提到的具体名称，禁止编造、禁止硬凑。如果摘要里没有明确的 AI 工具/模型/概念名称，输出空数组 []。' +
    '2.判断每个名称的类型 type，只能是以下五种之一：' +
    '"tool"：具体工具/软件/服务，单一可直接使用的产品（如 Cursor、Suno、Claude Code）；' +
    '"model"：官方以独立可调用型号发布的具体模型（如 Claude Opus 4.8、Kling 2.6 Pro）；无档位词不等于不是具体模型；无法确定是系列还是具体模型时标 "model" 交官方核验，不得自行降级；' +
    '"series"：模型系列/版本代际/产品线，官方按代际发布的家族名（如 GPT-5.6、GLM-5.3），其下可有 Sol、Terra、Luna 等具体型号；' +
    '"concept"：AI 概念/技术/方法（如 RAG、vibe coding、MoE、AI Agent）；' +
    '"vague"：产品/平台/品牌的笼统名，不是单一具体工具、具体模型或系列（如 通义千问、可灵、豆包、Kimi、腾讯混元、ChatGPT 品牌、API 服务、订阅套餐）。' +
    '3.排除泛称：AI、人工智能、AI 模型、AI 工具、AI 聊天机器人 这类泛指不算名称；' +
    '排除人名；排除机构/公司名（如字节跳动、Meta、三星，除非它的具体 AI 产品被点名）；排除与 AI 无关的普通词。' +
    '4.输出完整名，多词名不拆散（"Claude Code" 是一个整体，不要拆成 "Claude" 和 "Code"）。' +
    '5.找完后把摘要再检查一遍：确认没有遗漏的具体名称，也没有把泛称或无关词误当名称。' +
    '6.输出格式：一个 JSON 数组，每个元素是 {name, type}。如 [{"name":"Cursor","type":"tool"},{"name":"GLM-5.3","type":"series"},{"name":"RAG","type":"concept"}]；没有则 []。' +
    '注意：分不清是系列还是具体模型时标 model，交官方核验，不得自行降级为 vague；确属笼统品牌/平台/家族名时才标 vague。';
}

/** validate：只接受类型数组 [{name, type∈ENTITY_TYPES}]；裸字符串数组 / {names} / {entities} 一律 invalid（调用方降级正则）。 */
function validateExtractOutput(value) {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  return value.every(item => item && typeof item === 'object' &&
    typeof item.name === 'string' && ENTITY_TYPES.includes(item.type));
}

/** 归一化为 [{name, type}]：只保留带合法类型的对象项；无类型字符串与非法 type 一律忽略（不再兜底 tool）。 */
function toEntityList(value) {
  const list = Array.isArray(value) ? value : [];
  const entities = [];
  for (const item of list) {
    if (item && typeof item === 'object' && typeof item.name === 'string'
      && ENTITY_TYPES.includes(item.type)) {
      const name = item.name.trim();
      if (name) entities.push({ name, type: item.type });
    }
  }
  return entities;
}

/** 仅取名称（兼容旧调用方）。 */
function toNameList(value) {
  return toEntityList(value).map(entity => entity.name);
}

/**
 * 用外部 provider 从一段摘要提取带类型的 AI 实体。
 * @param {string} text 摘要正文
 * @param {object} [options] { ledger, catalogApi, model, apiKey, fetchImpl, timeoutMs, maxOutputTokens }
 *   - catalogApi  { createEntityLedger, resolveEntityModel } 注入（组合根构造）；
 *                 options.ledger 优先，其次 catalogApi.createEntityLedger()，都没有则抛错
 *   - model       显式模型优先；其次 catalogApi.resolveEntityModel() 兜底
 * @returns {Promise<Array<{name: string, type: 'tool'|'model'|'series'|'concept'|'vague'}>>}
 *   实体数组；调用失败时抛错（调用方据此降级正则）。
 */
async function extractEntitiesWithLlm(text, options = {}) {
  const catalogApi = options.catalogApi || {};
  if (!options.ledger && typeof catalogApi.createEntityLedger !== 'function') {
    throw new Error('实体提取需要注入 ledger 或 catalogApi.createEntityLedger（fail-closed 成本记账）');
  }
  const ledger = options.ledger || catalogApi.createEntityLedger();
  const result = await requestStructuredJson({
    kind: 'entity_extract',
    instructions: buildEntityExtractInstructions(),
    input: JSON.stringify({ text: String(text || '') }),
    maxOutputTokens: options.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    ledger,
    validate: validateExtractOutput,
  }, {
    model: options.model || (typeof catalogApi.resolveEntityModel === 'function' ? catalogApi.resolveEntityModel() : undefined),
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    endpoint: options.endpoint || LOCAL_API_BASE,
  });
  if (!result.ok) {
    const error = new Error(result.error || result.code || 'ENTITY_EXTRACT_FAILED');
    error.code = result.code;
    throw error;
  }
  return toEntityList(result.value);
}

module.exports = {
  ENTITY_TYPES,
  buildEntityExtractInstructions,
  validateExtractOutput,
  toEntityList,
  toNameList,
  extractEntitiesWithLlm,
};
