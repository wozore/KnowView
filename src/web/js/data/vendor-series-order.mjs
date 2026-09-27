/** vendor-series-order.mjs — 厂商系列和具体模型的展示排序。 */

import { isDateValue } from '../ui/date-display.mjs';

const nameCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const kindOrder = { model_series: 0, tool_series: 1, subscription_series: 2 };

function compareNames(a, b) {
  return nameCollator.compare(String(a.title || ''), String(b.title || ''))
    || String(a.id || '').localeCompare(String(b.id || ''));
}

function groupKind(group, detailsById) {
  if (group.series_kind) return group.series_kind;
  return (group.detail_refs || []).some(ref => detailsById.get(ref.id)?.detail_kind === 'api_model')
    ? 'model_series' : 'tool_series';
}

function sortVendorGroups(groups, level2Refs = [], details = []) {
  const detailsById = new Map(details.map(item => [item.id, item]));
  const refOrder = new Map(level2Refs.map((ref, index) => [ref.id, index]));
  return [...groups].sort((a, b) => {
    const aKind = groupKind(a, detailsById);
    const bKind = groupKind(b, detailsById);
    const kindDiff = (kindOrder[aKind] ?? 3) - (kindOrder[bKind] ?? 3);
    if (kindDiff) return kindDiff;
    const aOrder = refOrder.get(a.id);
    const bOrder = refOrder.get(b.id);
    if (aOrder === undefined && bOrder === undefined) return compareNames(a, b);
    if (aOrder === undefined) return 1;
    if (bOrder === undefined) return -1;
    return aOrder - bOrder || compareNames(a, b);
  });
}

function sortSeriesMembers(group, details) {
  const detailsById = new Map(details.map(item => [item.id, item]));
  if (groupKind(group, detailsById) !== 'model_series') return [...details];
  return [...details].sort((a, b) => {
    const aDate = isDateValue(a.release_date) ? a.release_date : '';
    const bDate = isDateValue(b.release_date) ? b.release_date : '';
    return bDate.localeCompare(aDate) || compareNames(a, b);
  });
}

export { groupKind, sortVendorGroups, sortSeriesMembers };
