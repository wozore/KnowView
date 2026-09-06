/**
 * model-series-index.mjs — 前端模型系列索引与匹配（浏览器可测纯逻辑）
 *
 * 系列判定：series_kind === 'model_series'，存量数据回退"任一成员为 api_model"。
 * 词形索引分两层：bySeriesWord（系列标题词形 → 系列）与 byMemberWord（成员卡词形 → 成员）。
 * matchSeries 最长词决定：成员词更长只返回该成员（role: 'member'），系列词命中返回该系列
 * 全部可见成员（role: 'series'），长度并列时系列优先。hidden_history 卡一律不可见。
 */

const WORD_SPLIT_RE = /[\s\-_.:/·,，、（）()]+/;

function normalizeWord(word) {
  return String(word || '').trim().toLocaleLowerCase('zh-CN').normalize('NFKC');
}

function deriveWordForms(word) {
  const text = String(word || '').trim();
  if (!text || text.length < 2) return [];
  const first = text.split(WORD_SPLIT_RE)[0].trim();
  const forms = [text];
  if (first && first.length >= 2 && first !== text) forms.push(first);
  return forms;
}

function isHiddenHistory(card) {
  return card?.visibility === 'hidden_history';
}

function isLevel3Hidden(level3ById, detailId) {
  return level3ById.get(detailId)?.visibility === 'hidden_history';
}

// 系列判定：显式 model_series；存量无 series_kind 时回退任一成员 api_model；
// 其他显式 series_kind（subscription_series/tool_series）不进入模型系列索引。
function isModelSeriesGroup(level2, level3ById) {
  if (level2?.series_kind === 'model_series') return true;
  if (level2?.series_kind) return false;
  return (Array.isArray(level2?.detail_refs) ? level2.detail_refs : [])
    .some(ref => level3ById.get(ref?.id)?.detail_kind === 'api_model');
}

function memberForms(card) {
  const forms = [];
  for (const word of [card?.title, card?.vendor_label, ...(card?.search_terms || [])]) {
    for (const form of deriveWordForms(word)) forms.push(form);
  }
  return forms;
}

/**
 * 构建系列索引。toolCards 传入可见卡（调用方负责过滤或全量；hidden_history 成员在
 * 索引内也会被剔除）。返回 { series, bySeriesWord, byMemberWord }。
 */
function buildSeriesIndex({ toolCards, level2s, level3s }) {
  const cards = Array.isArray(toolCards) ? toolCards : [];
  const groups = Array.isArray(level2s) ? level2s : [];
  const details = Array.isArray(level3s) ? level3s : [];
  const level3ById = new Map(details.map(item => [item?.id, item]));
  const cardByDetailId = new Map();
  for (const card of cards) {
    if (card?.detail_ref?.id) cardByDetailId.set(card.detail_ref.id, card);
  }

  const series = [];
  for (const group of groups) {
    if (!isModelSeriesGroup(group, level3ById)) continue;
    const memberCards = (Array.isArray(group.detail_refs) ? group.detail_refs : [])
      .map(ref => cardByDetailId.get(ref?.id))
      .filter(card => card && !isHiddenHistory(card) && !isLevel3Hidden(level3ById, card.detail_ref.id));
    series.push({
      series_id: group.id,
      series_title: group.title || '',
      vendor_key: group.vendor_key || '',
      member_cards: memberCards,
    });
  }
  const seriesById = new Map(series.map(entry => [entry.series_id, entry]));

  const bySeriesWord = new Map();
  for (const entry of series) {
    for (const form of deriveWordForms(entry.series_title)) {
      const key = normalizeWord(form);
      if (!key) continue;
      if (!bySeriesWord.has(key)) bySeriesWord.set(key, []);
      bySeriesWord.get(key).push(entry);
    }
  }

  const byMemberWord = new Map();
  for (const entry of series) {
    for (const card of entry.member_cards) {
      for (const form of memberForms(card)) {
        const key = normalizeWord(form);
        if (!key) continue;
        if (!byMemberWord.has(key)) byMemberWord.set(key, new Map());
        byMemberWord.get(key).set(card.id, { card, series: entry });
      }
    }
  }

  return { series, bySeriesWord, byMemberWord, seriesById, level3ById };
}

function seriesContextOf(entry, role) {
  return {
    series_id: entry.series_id,
    series_title: entry.series_title,
    role,
    member_count: entry.member_cards.length,
  };
}

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter(item => !seen.has(item.card.id) && seen.add(item.card.id));
}

/**
 * 系列感知匹配：词为 query 子串即命中；最长词决定角色，长度并列时系列优先。
 * @returns null 或 { role: 'series'|'member', entries: [{card, series_context}] }
 */
function matchSeries(index, query) {
  const needle = normalizeWord(query);
  if (!needle || !index) return null;

  const seriesHits = [];
  for (const [word, entries] of index.bySeriesWord || []) {
    if (needle.includes(word)) seriesHits.push({ word, entries });
  }
  const memberHits = [];
  for (const [word, members] of index.byMemberWord || []) {
    if (needle.includes(word)) {
      for (const { card, series } of members.values()) memberHits.push({ word, card, series });
    }
  }
  if (!seriesHits.length && !memberHits.length) return null;

  const maxSeriesWord = seriesHits.reduce((max, hit) => Math.max(max, hit.word.length), 0);
  const maxMemberWord = memberHits.reduce((max, hit) => Math.max(max, hit.word.length), 0);

  if (maxMemberWord > maxSeriesWord) {
    const entries = dedupeEntries(memberHits
      .filter(hit => hit.word.length === maxMemberWord)
      .map(hit => ({ card: hit.card, series_context: seriesContextOf(hit.series, 'member') })));
    return entries.length ? { role: 'member', entries } : null;
  }

  const winningSeries = new Map();
  for (const hit of seriesHits) {
    if (hit.word.length !== maxSeriesWord) continue;
    for (const entry of hit.entries) winningSeries.set(entry.series_id, entry);
  }
  const entries = [];
  for (const entry of winningSeries.values()) {
    for (const card of entry.member_cards) {
      entries.push({ card, series_context: seriesContextOf(entry, 'series') });
    }
  }
  return entries.length ? { role: 'series', entries } : null;
}

export { isHiddenHistory, buildSeriesIndex, matchSeries, normalizeWord, deriveWordForms };
