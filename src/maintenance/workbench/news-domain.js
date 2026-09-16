'use strict';

const path = require('path');
const fs = require('fs');
const minStore = require('../../news/min/min-store');
const minActions = require('../../news/min/min-review-actions');
const { buildDailyProjection } = require('../../news/min/daily-projection');
const { enrichHotspotProjection, buildProjectionInputs } = require('../../news/pipeline/projection');
const { filterProjectionByWindow } = require('../../news/core/news-public-gate');
const { minReviewCommand } = require('../../news/cli/cmd-min');
const {
  KEYWORD_PURPOSES,
  resolvePurpose,
  revisionOfConfig,
  commitKeywordActions,
  commitKeywordExclusions,
} = require('../../news/min/keyword-actions');
const { uploadTranscript, summarizeTranscripts } = require('../../news/min/transcript-workflow');
const { catalog } = require('../../catalog/interface');
const { createCostLedger } = require('../../catalog/core/index');
const { loadGeneratorConfig } = require('../../catalog/draft/index');
const { generateRss } = require('../../content/generate-rss');
const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { DIRS, NEWS_FILES, CATALOG_FILES } = require('../../shared/paths');
const { loadDotEnv } = require('../../shared/env');

function requireMutation(name, value) {
  if (typeof value !== 'function') throw new Error(`${name} mutation API 不可用`);
  return value;
}

/**
 * news 域目录查询适配器（maintenance 装配层拥有，组合根注入给 news 模块）。
 * news 域自身不 require catalog 域；本文件是唯一把目录数据翻译成 news 查询面的位置。
 * 形状：{ listToolCards, listVendorCards, readGlossary, readScenes, createEntityLedger, resolveEntityModel }
 */
function createNewsCatalogApi() {
  return {
    listToolCards: () => {
      const result = catalog({ area: 'tool-card', operation: 'list' });
      return result.ok ? result.data : [];
    },
    listVendorCards: () => {
      const result = catalog({ area: 'vendor-card', operation: 'list' });
      return result.ok ? result.data : [];
    },
    readGlossary: () => {
      try { return readJson(CATALOG_FILES.glossary, []); } catch { return []; }
    },
    readScenes: () => {
      try {
        const data = readJson(CATALOG_FILES.scenes, { scenes: [] });
        return Array.isArray(data) ? data : (data.scenes || []);
      } catch { return []; }
    },
    createEntityLedger: () => createCostLedger({ responses_calls: 1, synthesis_calls: 0 }),
    resolveEntityModel: () => {
      try { return loadGeneratorConfig().model; } catch { return undefined; }
    },
  };
}

// 公开投影的目录输入在进程内构建一次（与原 projection 模块级缓存同语义）。
let cachedProjectionInputs = null;

function publishNewsProjectionDirect(catalogApi = null) {
  if (cachedProjectionInputs === null || catalogApi) {
    cachedProjectionInputs = buildProjectionInputs(catalogApi || createNewsCatalogApi());
  }
  const config = readJson(NEWS_FILES.configV2, null);
  const store = minStore.readMinStore();
  const projection = buildDailyProjection(store, config, { now: new Date() });
  enrichHotspotProjection(projection.items, cachedProjectionInputs.toolUrlIndex, cachedProjectionInputs.relatedLexicon);
  const output = {
    schema_version: 1,
    generated_at: projection.generated_at,
    items: projection.items,
    coverage: { status: 'published_min', source: 'min-candidates.json', generated_at: projection.generated_at },
  };
  const filtered = filterProjectionByWindow(output, { config, now: Date.now() });
  if (filtered.items.length === 0) {
    return { dry_run: false, items: 0, skipped_empty: true };
  }
  writeJsonAtomic(NEWS_FILES.hotspots, filtered, `publish-min-${Date.now()}`);
  generateRss();
  return { dry_run: false, items: filtered.items.length };
}

function unresolvedKeywordCount(news) {
  const config = news.readConfig() || {};
  let total = 0;
  for (const purpose of ['content', 'youtube', 'x_discovery']) {
    const def = KEYWORD_PURPOSES[purpose];
    const list = news.readKeywords(purpose) || {};
    const existingList = Array.isArray(config?.keywords?.[def.targetField]) ? config.keywords[def.targetField] : [];
    const excludedList = Array.isArray(config?.keywords?.[def.excludedField]) ? config.keywords[def.excludedField] : [];
    const adopted = new Set(existingList.map(item => (typeof item === 'object' && item ? String(item.id || item.query).trim().toLowerCase() : String(item).trim().toLowerCase())));
    const discarded = new Set(excludedList.map(item => String(item).trim().toLowerCase()));
    const unhandled = (Array.isArray(list.candidates) ? list.candidates : []).filter(item => {
      const val = item?.value || item?.word || item?.id;
      const key = String(val || '').trim().toLowerCase();
      return key && !adopted.has(key) && !discarded.has(key);
    }).length;
    total += unhandled;
  }
  return total;
}

function createDefaultNewsApi(options = {}) {
  const catalogApi = options.catalogApi || createNewsCatalogApi();
  return {
    readStore: () => minStore.readMinStore(),
    revisionOfStore: store => requireMutation('revisionOfMinStore', minStore.revisionOfMinStore)(store),
    commit: (mutation, commitOptions) => requireMutation('commitMinStoreMutation', minStore.commitMinStoreMutation)(mutation, commitOptions),
    reviewMutation: (store, ids, decision, mutationOptions) => requireMutation('transitionReviewStatusMin', minActions.transitionReviewStatusMin)(store, ids, decision, mutationOptions),
    topMutation: (store, ids, selected, mutationOptions) => requireMutation('setApprovedTopSelectedMin', minActions.setApprovedTopSelectedMin)(store, ids, selected, mutationOptions),
    resetTopMutation: (store, ids, mutationOptions) => requireMutation('resetTopSelectionsMin', minActions.resetTopSelectionsMin)(store, ids, mutationOptions),
    readKeywords: (purpose = 'content') => {
      const def = resolvePurpose(purpose);
      const filePath = path.join(DIRS.manual, def.fileName);
      return readJson(filePath, null);
    },
    readConfig: () => readJson(NEWS_FILES.configV2, {}),
    revisionOfConfig: config => revisionOfConfig(config),
    commitKeywords: (list, commitOptions) => commitKeywordActions(list, commitOptions),
    commitKeywordExclusions: (words, commitOptions) => commitKeywordExclusions(words, commitOptions),
    uploadTranscript: (payload, commitOptions) => uploadTranscript(payload.candidate_id, payload.filename, payload.content_base64, commitOptions),
    summarizeTranscripts: (ids, commitOptions) => summarizeTranscripts(ids, commitOptions),
    generateKeywords: async (purpose = 'content') => {
      loadDotEnv();
      return minReviewCommand('refine', { purpose });
    },
    generateTop: async () => {
      loadDotEnv();
      return minReviewCommand('ai-top', {});
    },
    repairNews: async (flags = {}) => {
      loadDotEnv();
      return minReviewCommand('repair', flags);
    },
    publish: () => publishNewsProjectionDirect(catalogApi),
  };
}

function handleNewsReview({ store, news, options, newsProjection }, filter = null) {
  const currentStore = store();
  const allCandidates = currentStore.candidates || [];
  const counts = {
    pending: allCandidates.filter(item => item.review_status === 'pending').length,
    approved: allCandidates.filter(item => item.review_status === 'approved').length,
    discarded: allCandidates.filter(item => item.review_status === 'discarded').length,
    total: allCandidates.length,
  };
  const allPending = allCandidates.filter(item => item.review_status === 'pending');
  const unreviewed = allPending.filter(item => {
    const hasL1 = Boolean(item.l1_review && item.l1_review.verdict != null);
    const hasAdvice = Boolean(item.ai_advice?.verdict);
    return !hasL1 && !hasAdvice;
  });
  if ((!filter || filter === 'pending') && unreviewed.length > 0) {
    if (options.autoRepair !== false && typeof news.repairNews === 'function') {
      Promise.resolve().then(() => news.repairNews({ limit: unreviewed.length })).catch(() => {});
    }
    const enrichingResult = {
      revision: news.revisionOfStore(currentStore),
      status: 'enriching',
      message: `本地 Bonsai 正在进行 AI 初审分流与汉化（已链接外部 API 双通道自愈兜底，请稍候... 待初审: ${unreviewed.length} / 待审总数: ${allPending.length}）`,
      unreviewed_count: unreviewed.length,
      items: [],
    };
    return filter ? { ...enrichingResult, counts, filter } : enrichingResult;
  }
  let targets = allPending;
  if (filter === 'approved') targets = allCandidates.filter(item => item.review_status === 'approved');
  else if (filter === 'discarded') targets = allCandidates.filter(item => item.review_status === 'discarded');
  else if (filter === 'all') targets = allCandidates;
  const base = newsProjection(targets);
  return filter ? { ...base, counts, filter } : base;
}

function handleReviewNews(body, news, { idsOf, expectedRevision }) {
  const ids = idsOf(body?.ids);
  const revision = expectedRevision(body);
  const decision = body?.decision;
  if (!['approved', 'discarded', 'pending'].includes(decision)) {
    throw new Error('decision 必须是 approved、discarded 或 pending');
  }
  const result = news.commit(current => news.reviewMutation(current, ids, decision, { expectedRevision: revision }), { expectedRevision: revision, runId: 'maintainer-workbench-news-review' });
  return {
    updated: result.updated,
    missing: result.missing || [],
    not_pending: result.not_pending || [],
    revision: result.revision,
    ...(Array.isArray(result.unchanged) && result.unchanged.length ? { unchanged: result.unchanged } : {}),
  };
}

function handleResetTop(body, news, options = {}) {
  const currentStore = options.store ? options.store() : { candidates: [] };
  const revision = (typeof options.expectedRevision === 'function' && body)
    ? options.expectedRevision(body)
    : (body?.expected_revision || news.revisionOfStore(currentStore));
  const topFile = options.topFile || path.join(DIRS.manual, 'top.json');
  let discardedPool = false;
  if (body?.discard_pool === true && fs.existsSync(topFile)) {
    try {
      fs.unlinkSync(topFile);
      discardedPool = true;
    } catch (_) {}
  }
  const ids = Array.isArray(body?.ids) && body.ids.length ? body.ids : null;
  const result = news.commit(
    current => news.resetTopMutation(current, ids, { expectedRevision: revision }),
    { expectedRevision: revision, runId: 'maintainer-workbench-top-reset' },
  );
  return {
    updated: result.updated,
    discarded_pool: discardedPool,
    revision: result.revision,
  };
}

function handleKeywords(news, requestedPurpose = 'content') {
  const config = news.readConfig();
  const purpose = requestedPurpose || 'content';
  const def = resolvePurpose(purpose);
  const list = news.readKeywords(purpose);
  const existingList = Array.isArray(config?.keywords?.[def.targetField])
    ? config.keywords[def.targetField]
    : (Array.isArray(config?.keywords?.ai_keywords) ? config.keywords.ai_keywords : []);
  const excludedList = Array.isArray(config?.keywords?.[def.excludedField])
    ? config.keywords[def.excludedField]
    : (Array.isArray(config?.keywords?.excluded_keywords) ? config.keywords.excluded_keywords : []);
  const adoptedSet = new Set(existingList.map(item => (typeof item === 'object' && item ? String(item.id || item.query).trim().toLowerCase() : String(item).trim().toLowerCase())));
  const excludedSet = new Set(excludedList.map(item => String(item).trim().toLowerCase()));

  const items = Array.isArray(list?.candidates) ? list.candidates.map(item => {
    const val = item?.value || item?.word || item?.id;
    const cid = item?.candidate_id || (item?.id ? item.id : `${purpose}:${val}`);
    const key = String(val || '').trim().toLowerCase();
    const idKey = String(cid).trim().toLowerCase();
    const res = {
      ...item,
      id: item?.id || cid,
      word: typeof val === 'object' && val ? (val.query || val.id) : String(val || item?.word || ''),
      adopted: adoptedSet.has(key) || adoptedSet.has(idKey),
      discarded: excludedSet.has(key) || excludedSet.has(idKey),
    };
    if (item?.candidate_id || purpose !== 'content') {
      res.candidate_id = cid;
      res.purpose = purpose;
      res.value = val;
    }
    return res;
  }) : [];
  const hasSource = list && (list.source_count != null || list.input_count != null || list.source_basis != null);
  return {
    ...(purpose !== 'content' ? { purpose } : {}),
    revision: news.revisionOfConfig(config),
    ...(hasSource ? { source: { source_count: list.source_count ?? null, input_count: list.input_count ?? null, source_basis: list.source_basis ?? null } } : {}),
    items,
  };
}

function handleApplyKeywords(body, news, { idsOf, expectedRevision }) {
  const ids = idsOf(body?.ids);
  const revision = expectedRevision(body);
  const purpose = body?.purpose || 'content';
  const list = news.readKeywords(purpose);
  if (!list || !Array.isArray(list.candidates)) throw new Error('关键词候选清单不存在或无效');
  const selected = new Set(ids);
  const adopted_candidate_ids = list.candidates
    .filter(item => {
      const cid = String(item.candidate_id || item.id || `${purpose}:${item.value || item.word}`);
      const val = String(item.value || item.word || '');
      return selected.has(cid) || selected.has(val);
    })
    .map(item => item.candidate_id || `${purpose}:${item.value || item.word}`);
  if (adopted_candidate_ids.length !== selected.size) throw new Error('存在未知关键词 id');
  return news.commitKeywords({ ...list, purpose, adopted_candidate_ids }, { expectedRevision: revision, purpose, runId: 'maintainer-workbench-keywords' });
}

function handleDiscardKeywords(body, news, { idsOf, expectedRevision }) {
  const words = idsOf(body?.ids);
  const revision = expectedRevision(body);
  const purpose = body?.purpose || 'content';
  const list = news.readKeywords(purpose);
  const selected = new Set(words);
  let resolvedValues = words;
  if (list && Array.isArray(list.candidates)) {
    resolvedValues = list.candidates
      .filter(item => {
        const cid = String(item.candidate_id || item.id || `${purpose}:${item.value || item.word}`);
        const val = String(item.value || item.word || '');
        return selected.has(cid) || selected.has(val);
      })
      .map(item => (typeof item.value === 'object' && item.value ? item.value.id : String(item.value || item.word || '')));
  }
  return news.commitKeywordExclusions(resolvedValues, { purpose, expectedRevision: revision, runId: 'maintainer-workbench-keywords-discard' });
}

function handleTop(store, news, options) {
  const current = store();
  const approvedIds = new Set(current.candidates.filter(candidate => candidate.review_status === 'approved').map(candidate => candidate.id));
  const topFile = options.topFile || path.join(DIRS.manual, 'top.json');
  let items = [];
  let note = null;
  if (fs.existsSync(topFile)) {
    const list = readJson(topFile, null);
    if (list && Array.isArray(list.candidates)) {
      items = list.candidates
        .filter(entry => entry && entry.id != null && approvedIds.has(String(entry.id)))
        .map(entry => {
          const candidate = current.candidates.find(item => item.id === String(entry.id));
          const zh = candidate && candidate.localizations && candidate.localizations.zh;
          return {
            id: String(entry.id),
            url: candidate?.url || entry.url || null,
            title: zh && (zh.title || zh.summary) ? (zh.title || zh.summary) : String(entry.summary || candidate?.title || entry.description || ''),
            summary: zh && zh.description ? zh.description : String(entry.description || candidate?.description || entry.summary || ''),
            top_selected: Boolean(candidate && candidate.top_selected === true),
            score: entry.score ?? null,
            transcript_status: !candidate?.transcript ? 'none' : (candidate.transcript_summarized_at ? 'summarized' : 'uploaded'),
            transcript_file: candidate?.transcript_file || null,
            platform: candidate?.platform || entry.platform || null,
          };
        });
    } else {
      note = 'Top 待选池结构无效，请重新运行 min-review ai-top';
    }
  } else {
    note = '尚未生成 Top 待选池：先运行 min-review ai-top（纯 X 10 / 有 YouTube 15），再从池中选 3~5/3~8 条。';
  }
  return { revision: news.revisionOfStore(current), items, note };
}

function handleApplyTop(body, news, { idsOf, expectedRevision }) {
  const ids = idsOf(body?.ids);
  const revision = expectedRevision(body);
  if (typeof body?.selected !== 'boolean') throw new Error('selected 必须显式为 boolean');
  const result = news.commit(current => news.topMutation(current, ids, body.selected, { expectedRevision: revision }), { expectedRevision: revision, runId: 'maintainer-workbench-top' });
  return { updated: result.updated, missing: result.missing || [], not_approved: result.not_approved || [], revision: result.revision };
}

function handleUploadTranscript(body, news, expectedRevision) {
  const revision = expectedRevision(body);
  if (typeof body?.candidate_id !== 'string' || !body.candidate_id.trim()) throw new Error('candidate_id 必填');
  if (typeof body?.filename !== 'string' || !body.filename.trim()) throw new Error('字幕文件名必填');
  if (typeof body?.content_base64 !== 'string' || !body.content_base64) throw new Error('字幕文件内容必填');
  return news.uploadTranscript(body, { expectedRevision: revision });
}

function handleSummarizeTranscripts(body, news, { idsOf, expectedRevision }, runtime = {}) {
  const ids = idsOf(body?.ids);
  const revision = expectedRevision(body);
  const confirmCost = body?.confirm_cost === true;
  return news.summarizeTranscripts(ids, {
    expectedRevision: revision,
    confirmCost,
    signal: runtime.signal,
  });
}

module.exports = {
  createNewsCatalogApi,
  publishNewsProjectionDirect,
  unresolvedKeywordCount,
  createDefaultNewsApi,
  handleNewsReview,
  handleReviewNews,
  handleKeywords,
  handleApplyKeywords,
  handleDiscardKeywords,
  handleTop,
  handleResetTop,
  handleApplyTop,
  handleUploadTranscript,
  handleSummarizeTranscripts,
};
