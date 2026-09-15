'use strict';

// 本地 Bonsai 模型 OpenAI 兼容端点（llama-server）。
// 本地模型任务统一引用，避免散落魔法字符串：news 分类层 5 个本地任务经 llm-gateway
// 的 local provider 复用本常量（local-model.js），news/feedback、catalog 概念合成、
// catalog 工具更新审核、catalog intake、comparison 身份审核直接引用。
// L1 分类与目录合成走外部 provider（默认 ZhipuAI），不使用本常量。
const LOCAL_API_BASE = 'http://127.0.0.1:8080/v1/chat/completions';

// 本地模型名（llama-server 忽略实际值，仅作标识）
const LOCAL_MODEL = 'bonsai';

module.exports = {
  LOCAL_API_BASE,
  LOCAL_MODEL,
};
