'use strict';

function stableErrorCode(error, fallback) {
  const code = String(error?.code || '').split(':')[0];
  return /^[A-Z][A-Z0-9_]+$/.test(code) ? code : fallback;
}

async function verifyModelCandidate(verifyFn, candidate, context, adapters) {
  try {
    const result = await verifyFn(candidate, context, adapters);
    if (!result || typeof result !== 'object' || (result.ok && (!result.verdict || typeof result.verdict !== 'object'))) {
      return { ok: false, code: 'IDENTITY_VERIFICATION_RESULT_INVALID', error: '身份核验未返回有效结果。' };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      code: stableErrorCode(error, 'IDENTITY_VERIFICATION_FAILED'),
      error: error?.message || String(error),
    };
  }
}

async function discoverSeriesMembersSafely(membersFn, verdict, adapters, context) {
  try {
    let result = await membersFn(verdict, adapters, context);
    if (!result || typeof result !== 'object') {
      return { ok: false, code: 'IDENTITY_SERIES_MEMBERS_INVALID', error: '系列成员发现未返回有效结果。' };
    }
    if (result.ok && (!Array.isArray(result.members) || !result.members.length)) {
      result = await membersFn(verdict, adapters, context);
    }
    if (!result || typeof result !== 'object') {
      return { ok: false, code: 'IDENTITY_SERIES_MEMBERS_INVALID', error: '系列成员发现未返回有效结果。' };
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      code: stableErrorCode(error, 'IDENTITY_SERIES_MEMBERS_FAILED'),
      error: error?.message || String(error),
    };
  }
}

module.exports = { verifyModelCandidate, discoverSeriesMembersSafely };
