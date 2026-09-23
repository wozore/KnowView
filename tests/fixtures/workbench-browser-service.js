'use strict';

/**
 * workbench-browser-service.js — 维护者工作台浏览器验收的内存 fixture 服务。
 *
 * 供 scripts/browser-workbench-acceptance.js 经 createMaintainerWorkbenchServer
 * 的 options.service 注入：完全内存态、零 fs、零网络、零 .env，按真实 service
 * 在验收触达路由上的响应形状与 revision/CAS 语义返回。每次
 * createFixtureWorkbenchService() 产出独立、确定可重放的状态实例。
 *
 * fixture 方法 ↔ server 路由对应：
 *   overview()               GET  /overview
 *   config()                 GET  /config
 *   newsReview(status)       GET  /news/review?status=
 *   reviewNews(body)         POST /news/review
 *   keywords(purpose)        GET  /news/keywords?purpose=
 *   applyKeywords(body)      POST /news/keywords
 *   discardKeywords(body)    POST /news/keywords/discard
 *   generateKeywords(body)   POST /news/keywords/generate
 *   top()                    GET  /news/top
 *   generateTop()            POST /news/top/generate
 *   resetTop(body)           POST /news/top/reset
 *   applyTop(body)           POST /news/top
 *   publishNews()            POST /news/publish
 *   publishPreview()         GET  /news/publish-preview
 *   pendingTools()           GET  /feedback/tools
 *   pendingConcepts()        GET  /feedback/concepts
 *   reviewPendingTool(k,b)   POST /feedback/tools/:key/review
 *   toolUpdates()            GET  /tool-updates
 *   catalogDrafts()          GET  /catalog/drafts
 *   catalogBundles()         GET  /catalog/bundles
 *   conceptPreviews()        GET  /concepts/preview
 */

const INITIAL_REVISION = 1;

function createFixtureWorkbenchService() {
  const state = {
    revisionCounter: INITIAL_REVISION,
    news: [
      { id: 'fixture-news-1', title: 'Fixture 新闻候选 Alpha', summary: '内存 fixture 待审候选 Alpha 摘要', platform: 'youtube', review_status: 'pending' },
      { id: 'fixture-news-2', title: 'Fixture 新闻候选 Beta', summary: '内存 fixture 待审候选 Beta 摘要', platform: 'x', review_status: 'pending' },
      { id: 'fixture-news-3', title: 'Fixture 新闻候选 Gamma', summary: '内存 fixture 已批准候选 Gamma 摘要', platform: 'youtube', review_status: 'approved' },
      { id: 'fixture-news-4', title: 'Fixture 新闻候选 Delta', summary: '内存 fixture 已批准候选 Delta 摘要', platform: 'x', review_status: 'approved' },
    ],
    keywords: [
      { id: 'fixture-kw-1', word: 'fixture-alpha', count: 3, purpose: 'content', adopted: false, discarded: false },
      { id: 'fixture-kw-2', word: 'fixture-beta', count: 2, purpose: 'content', adopted: false, discarded: false },
    ],
    pendingTools: [
      { candidate_key: 'fixture-tool-alpha', name: 'Fixture 工具 Alpha', review_status: 'pending', workflow_state: 'pending_review', detail_kind_hint: 'tool' },
    ],
    topPool: [],
    published: [],
  };

  function revision() {
    return `fixture-rev-${state.revisionCounter}`;
  }

  function bumpRevision() {
    state.revisionCounter += 1;
    return revision();
  }

  function revisionConflict(expected) {
    return { ok: false, code: 'REVISION_CONFLICT', message: `fixture revision 已变化（期望 ${expected}，当前 ${revision()}）` };
  }

  function checkRevision(expected) {
    if (expected !== undefined && expected !== null && String(expected) !== revision()) {
      return revisionConflict(String(expected));
    }
    return null;
  }

  const envelope = payload => ({ revision: revision(), ...payload });

  const byStatus = status => state.news.filter(item => item.review_status === status);
  const activeKeywords = purpose => state.keywords
    .filter(item => (item.purpose || 'content') === purpose && item.adopted !== true && item.discarded !== true);

  function commitKeywordFlag(body, flag) {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    let updated = 0;
    for (const item of state.keywords) {
      if (ids.includes(item.id)) {
        item[flag] = true;
        updated += 1;
      }
    }
    return { ok: true, revision: bumpRevision(), updated };
  }

  return {
    overview() {
      return envelope({
        news_pending: byStatus('pending').length,
        keyword_candidates: activeKeywords('content').length,
        top_candidates: state.topPool.length,
        tool_updates_pending: 0,
        workspace: { clearable: false, blockers: [{ message: 'fixture：仍有待审条目' }] },
      });
    },

    config() {
      return envelope({ mode: 'read_only', groups: {} });
    },

    newsReview(status = 'pending') {
      const items = byStatus(status);
      return envelope({
        status,
        counts: {
          pending: byStatus('pending').length,
          approved: byStatus('approved').length,
          discarded: byStatus('discarded').length,
          total: state.news.length,
        },
        items,
      });
    },

    reviewNews(body = {}) {
      const conflict = checkRevision(body.expected_revision);
      if (conflict) return conflict;
      const decision = body.decision || body.status;
      if (!['pending', 'approved', 'discarded'].includes(decision)) {
        return { ok: false, code: 'PENDING_REVIEW_DECISION_INVALID', message: `fixture：非法审核状态 ${decision}` };
      }
      const ids = Array.isArray(body.ids) ? body.ids : [];
      let updated = 0;
      for (const item of state.news) {
        if (ids.includes(item.id)) {
          item.review_status = decision;
          updated += 1;
        }
      }
      return { ok: true, revision: bumpRevision(), updated };
    },

    keywords(purpose = 'content') {
      return envelope({
        purpose,
        source: { source_count: 4, input_count: 4 },
        items: state.keywords.filter(item => (item.purpose || 'content') === purpose),
      });
    },

    applyKeywords(body = {}) {
      const conflict = checkRevision(body.expected_revision);
      if (conflict) return conflict;
      return commitKeywordFlag(body, 'adopted');
    },

    discardKeywords(body = {}) {
      const conflict = checkRevision(body.expected_revision);
      if (conflict) return conflict;
      return commitKeywordFlag(body, 'discarded');
    },

    generateKeywords(body = {}) {
      const purpose = (body && body.purpose) || 'content';
      const candidates = activeKeywords(purpose);
      return { ok: true, revision: revision(), candidates, candidate_count: candidates.length };
    },

    top() {
      return envelope({ items: state.topPool });
    },

    generateTop() {
      const approved = byStatus('approved');
      state.topPool = approved.map((item, index) => ({
        id: `fixture-top-${item.id}`,
        news_id: item.id,
        title: item.title,
        summary: item.summary,
        platform: item.platform || 'youtube',
        url: `https://fixture.invalid/top/${item.id}`,
        score: 100 - index,
        top_selected: false,
        transcript_status: 'none',
      }));
      return { ok: true, revision: bumpRevision(), candidates: state.topPool, count: state.topPool.length, approved_count: approved.length };
    },

    resetTop(body = {}) {
      const conflict = checkRevision(body.expected_revision);
      if (conflict) return conflict;
      let updated = 0;
      for (const item of state.topPool) {
        if (item.top_selected === true) {
          item.top_selected = false;
          updated += 1;
        }
      }
      if (body.discard_pool === true) state.topPool = [];
      return { ok: true, revision: bumpRevision(), updated };
    },

    applyTop(body = {}) {
      const conflict = checkRevision(body.expected_revision);
      if (conflict) return conflict;
      const ids = Array.isArray(body.ids) ? body.ids : [];
      let updated = 0;
      for (const item of state.topPool) {
        if (ids.includes(item.id)) {
          item.top_selected = body.selected === false ? false : true;
          updated += 1;
        }
      }
      return { ok: true, revision: bumpRevision(), updated };
    },

    publishNews() {
      state.published = state.topPool
        .filter(item => item.top_selected === true)
        .map(item => ({ id: item.id, title: item.title, summary: item.summary, platform: item.platform, url: item.url }));
      return { ok: true, revision: bumpRevision(), items: state.published.length };
    },

    publishPreview() {
      return envelope({ title: '当前公开投影', items: state.published });
    },

    pendingTools() {
      const isPending = item => item.review_status === 'pending' || (item.review_status === 'approved' && item.workflow_state !== 'completed');
      const items = state.pendingTools.filter(isPending);
      const history_items = state.pendingTools.filter(item => !isPending(item));
      return envelope({
        items,
        history_items,
        history_count: history_items.length,
        active_count: items.length,
      });
    },

    pendingConcepts() {
      return envelope({ items: [], history_items: [], history_count: 0, active_count: 0 });
    },

    extractKnowledge(body = {}) {
      const conflict = checkRevision(body.expected_revision);
      if (conflict) return conflict;
      // 模拟从 approved 摘要提取知识：产出 Grok Voice Transcribe 2.0 model 卡，过滤 OpenAI/Anthropic
      const existing = state.pendingTools.find(t => t.candidate_key === 'grok-voice-transcribe-2-0');
      if (!existing) {
        state.pendingTools.push({
          candidate_key: 'grok-voice-transcribe-2-0',
          name: 'Grok Voice Transcribe 2.0',
          entity_type: 'model',
          detail_kind_hint: 'api_model',
          review_status: 'pending',
          workflow_state: 'pending_review',
          mentioned_in_summaries: 1,
          description: '',
        });
      }
      return {
        ok: true,
        tools_found: 0,
        concepts_found: 0,
        tools_pending: 1,
        concepts_pending: 0,
        pending_revisions: {
          tools: bumpRevision(),
          concepts: revision(),
        },
        diagnostics: {
          vague_filtered: [{ name: 'OpenAI', type: 'vague' }, { name: 'Anthropic', type: 'vague' }],
        },
      };
    },

    reviewPendingTool(candidateKey, body = {}) {
      const conflict = checkRevision(body.expected_revision);
      if (conflict) return conflict;
      const item = state.pendingTools.find(entry => entry.candidate_key === candidateKey);
      if (!item) {
        return { ok: false, code: 'PENDING_CANDIDATE_NOT_FOUND', message: `fixture：未知待补卡 ${candidateKey}` };
      }
      if (!['approved', 'discarded'].includes(body.decision)) {
        return { ok: false, code: 'PENDING_REVIEW_DECISION_INVALID', message: `fixture：非法待补卡决定 ${body.decision}` };
      }
      item.review_status = body.decision;
      item.workflow_state = body.decision === 'approved' ? 'approved_pending' : 'discarded';
      return { ok: true, revision: bumpRevision(), candidate_key: candidateKey, decision: body.decision };
    },

    toolUpdates() {
      return envelope({ items: [], history: [] });
    },

    catalogDrafts() {
      return { items: [] };
    },

    catalogBundles() {
      return { items: [] };
    },

    conceptPreviews() {
      return { status: 'no_preview', items: [] };
    },
  };
}

module.exports = { createFixtureWorkbenchService };
