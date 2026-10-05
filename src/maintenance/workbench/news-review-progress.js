'use strict';

function unreviewedCandidates(candidates) {
  return candidates.filter(item => item.review_status === 'pending'
    && !item.l1_review?.verdict && !item.ai_advice?.verdict);
}

function unreviewedKey(candidates) {
  return candidates.map(item => String(item.id)).sort().join('\n');
}

function hasProviderRejection(candidates) {
  return candidates.some(item => {
    const error = String(item.l1_review?.llm_error || '');
    return error.includes('HTTP 400') && error.includes('"code":"1301"');
  });
}

function checkAutoRepair({ store, news, options, state }, unreviewed, revision, pendingCount) {
  const key = unreviewedKey(unreviewed);
  if (state.failedKey && state.failedKey !== key) {
    state.failedKey = null;
    state.error = null;
  }
  if (!state.inFlight && hasProviderRejection(unreviewed)) {
    state.failedKey = key;
    state.error = '部分内容被 GLM 拒绝（错误码 1301），请人工审核。';
  }
  if (options.autoRepair !== false && typeof news.repairNews === 'function'
    && !state.inFlight && state.attemptedRevision !== revision && state.failedKey !== key) {
    state.attemptedRevision = revision;
    state.inFlight = Promise.resolve().then(() => news.repairNews({ limit: unreviewed.length }))
      .then(() => {
        const remaining = unreviewedCandidates(store().candidates);
        if (remaining.length > 0) {
          state.failedKey = unreviewedKey(remaining);
          state.error = `自动修复已结束，仍有 ${remaining.length} 条未得到有效初审结论。`;
          state.attemptedRevision = news.revisionOfStore(store());
        }
      }, error => {
        const remaining = unreviewedCandidates(store().candidates);
        state.failedKey = unreviewedKey(remaining);
        state.error = `GLM 初审失败：${error?.message || String(error)}`;
        state.attemptedRevision = news.revisionOfStore(store());
      })
      .finally(() => { state.inFlight = null; });
  }
  const failed = !state.inFlight && state.failedKey === key;
  return {
    failed,
    message: failed
      ? `${state.error} 请查看候选错误并决定是否重试或人工审核。`
      : `GLM 正在进行 AI 初审分流与汉化（待初审: ${unreviewed.length} / 待审总数: ${pendingCount}）`,
  };
}

module.exports = { unreviewedCandidates, checkAutoRepair };
