'use strict';

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateFamilyMemberLineages(vendorKey, family, detailKeyOf) {
  const errors = [];
  const lineages = family.member_lineages;
  const hasLineages = lineages !== undefined;
  const usableLineages = lineages && typeof lineages === 'object' && !Array.isArray(lineages);
  if (hasLineages && !usableLineages) errors.push(`SERIES_POLICY_MEMBER_LINEAGES_INVALID:${vendorKey}:${family.family}`);

  const expectedMemberIds = new Set();
  for (const series of Array.isArray(family.series) ? family.series : []) {
    const seenLineages = new Set();
    for (const member of Array.isArray(series.expected_members) ? series.expected_members : []) {
      const memberId = detailKeyOf(member);
      if (!memberId) continue;
      expectedMemberIds.add(memberId);
      if (!hasLineages || !usableLineages) continue;
      const lineage = lineages[memberId];
      if (typeof lineage !== 'string' || !lineage.trim()) {
        errors.push(`SERIES_POLICY_MEMBER_LINEAGE_MISSING:${series.id || vendorKey}:${memberId}`);
      } else if (seenLineages.has(lineage)) {
        errors.push(`SERIES_POLICY_MEMBER_LINEAGE_DUPLICATE:${series.id || vendorKey}:${lineage}`);
      } else {
        seenLineages.add(lineage);
      }
    }
  }

  const historyMembers = family.hidden_history_members === undefined ? [] : family.hidden_history_members;
  if (!Array.isArray(historyMembers)) {
    errors.push(`SERIES_POLICY_HIDDEN_HISTORY_MEMBERS_INVALID:${vendorKey}:${family.family}`);
    return errors;
  }
  const seenHistoryMembers = new Set();
  for (const item of historyMembers) {
    const memberId = detailKeyOf(item?.member);
    if (!memberId || !isIsoDate(item?.historical_since)) {
      errors.push(`SERIES_POLICY_HIDDEN_HISTORY_MEMBER_INVALID:${vendorKey}:${family.family}:${item?.member || ''}`);
      continue;
    }
    if (seenHistoryMembers.has(memberId)) errors.push(`SERIES_POLICY_HIDDEN_HISTORY_MEMBER_DUPLICATE:${vendorKey}:${family.family}:${memberId}`);
    if (expectedMemberIds.has(memberId)) errors.push(`SERIES_POLICY_HIDDEN_HISTORY_MEMBER_IN_ROSTER:${vendorKey}:${family.family}:${memberId}`);
    if (hasLineages && usableLineages
      && (typeof lineages[memberId] !== 'string' || !lineages[memberId].trim())) {
      errors.push(`SERIES_POLICY_MEMBER_LINEAGE_MISSING:${family.family}:${memberId}`);
    }
    seenHistoryMembers.add(memberId);
  }
  if (usableLineages) {
    for (const memberId of Object.keys(lineages)) {
      if (!expectedMemberIds.has(memberId) && !seenHistoryMembers.has(memberId)) {
        errors.push(`SERIES_POLICY_MEMBER_LINEAGE_UNUSED:${vendorKey}:${family.family}:${memberId}`);
      }
    }
  }
  return errors;
}

module.exports = { validateFamilyMemberLineages };
