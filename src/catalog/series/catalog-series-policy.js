'use strict';

const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { readJson } = require('../../shared/json-store');
const { REF_TARGETS, emptySnapshot } = require('../core/catalog-contract');

const USAGE_KINDS = Object.freeze([
  'general_llm', 'coding', 'image', 'video', 'audio_realtime',
  'translation', 'omni', 'media', 'subscription', 'tool', 'unknown',
]);

const EVIDENCE_STATUS = Object.freeze(['verified', 'repository_only', 'inferred']);
const GENERATION_STATES = Object.freeze(['newest', 'previous']);
const VENDOR_DIRECTIONS = Object.freeze(['llm', 'video', 'image', 'search_platform', 'infrastructure']);
const FAMILY_MODALITIES = Object.freeze(['text', 'image', 'video', 'audio', 'omni']);
const FAMILY_SERIES_KINDS = Object.freeze(['model_series', 'subscription_series', 'tool_series']);

const DETAIL_REF_KIND = 'tool-level3';

function readSeriesPolicy(filePath) {
  const payload = readJson(filePath || CATALOG_GENERATOR_FILES.seriesPolicy, null);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('SERIES_POLICY_INVALID_ROOT');
  }
  return payload;
}

function detailKeyOf(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.startsWith(`${DETAIL_REF_KIND}:`) ? text.slice(DETAIL_REF_KIND.length + 1) : text;
}

function detailRefIdOf(value) {
  const key = detailKeyOf(value);
  if (!key) return null;
  return `${DETAIL_REF_KIND}:${key}`;
}

const REQUIRED_TOPS = ['schema_version', 'capacity', 'defaults', 'vendor_aliases', 'vendors'];

function validateSeriesPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return ['SERIES_POLICY_ROOT_INVALID'];
  }
  for (const top of REQUIRED_TOPS) {
    if (!(top in policy)) errors.push(`SERIES_POLICY_MISSING_TOP:${top}`);
  }
  if (errors.length) return errors;

  if (!Number.isInteger(policy.schema_version) || policy.schema_version < 1) errors.push('SERIES_POLICY_SCHEMA_VERSION_INVALID');
  if (typeof policy.verified_at !== 'string' || !policy.verified_at) errors.push('SERIES_POLICY_VERIFIED_AT_INVALID');

  const cap = policy.capacity;
  if (!cap || !Number.isInteger(cap.visible_members) || cap.visible_members < 1
    || !Number.isInteger(cap.history_retention_months) || cap.history_retention_months < 1) {
    errors.push('SERIES_POLICY_CAPACITY_INVALID');
  }

  if (policy.vendor_direction_suggestions !== undefined && !Array.isArray(policy.vendor_direction_suggestions)) {
    errors.push('SERIES_POLICY_DIRECTION_SUGGESTIONS_INVALID');
  }

  if (!policy.defaults || typeof policy.defaults !== 'object') errors.push('SERIES_POLICY_DEFAULTS_INVALID');
  if (!policy.vendor_aliases || typeof policy.vendor_aliases !== 'object' || Array.isArray(policy.vendor_aliases)) {
    errors.push('SERIES_POLICY_VENDOR_ALIASES_INVALID');
  }

  if (!Array.isArray(policy.vendors) || !policy.vendors.length) {
    errors.push('SERIES_POLICY_VENDORS_EMPTY');
    return errors;
  }

  const seenVendor = new Set();
  const seenSeriesId = new Set();
  const vendorAliases = policy.vendor_aliases || {};
  for (const alias of Object.values(vendorAliases)) {
    if (!Array.isArray(alias)) errors.push('SERIES_POLICY_ALIAS_NOT_ARRAY');
  }

  for (const vendor of policy.vendors) {
    const vk = vendor && vendor.vendor_key;
    if (!vk || typeof vk !== 'string') { errors.push('SERIES_POLICY_VENDOR_KEY_INVALID'); continue; }
    if (seenVendor.has(vk)) errors.push(`SERIES_POLICY_VENDOR_DUPLICATE:${vk}`);
    seenVendor.add(vk);
    if (!VENDOR_DIRECTIONS.includes(vendor.direction)) errors.push(`SERIES_POLICY_VENDOR_DIRECTION_INVALID:${vk}:${vendor.direction}`);

    if (!Array.isArray(vendor.families)) {
      errors.push(`SERIES_POLICY_VENDOR_NO_FAMILY:${vk}`);
      continue;
    }
    const seenFamily = new Set();
    for (const family of vendor.families) {
      if (!family || typeof family.family !== 'string' || !family.family) {
        errors.push(`SERIES_POLICY_FAMILY_INVALID:${vk}`);
        continue;
      }
      if (seenFamily.has(family.family)) errors.push(`SERIES_POLICY_FAMILY_DUPLICATE:${vk}:${family.family}`);
      seenFamily.add(family.family);
      if (!USAGE_KINDS.includes(family.usage_kind)) {
        errors.push(`SERIES_POLICY_USAGE_INVALID:${vk}:${family.family}:${family.usage_kind}`);
      }
      if (!FAMILY_MODALITIES.includes(family.modality)) errors.push(`SERIES_POLICY_FAMILY_MODALITY_INVALID:${vk}:${family.family}:${family.modality}`);
      if (!FAMILY_SERIES_KINDS.includes(family.series_kind)) errors.push(`SERIES_POLICY_FAMILY_SERIES_KIND_INVALID:${vk}:${family.family}:${family.series_kind}`);
      if (family.version_axis && typeof family.version_axis !== 'string') errors.push(`SERIES_POLICY_VERSION_AXIS_INVALID:${vk}:${family.family}`);
      if (family.name_patterns && !Array.isArray(family.name_patterns)) errors.push(`SERIES_POLICY_NAME_PATTERNS_INVALID:${vk}:${family.family}`);

      if (!Array.isArray(family.series) || !family.series.length) {
        errors.push(`SERIES_POLICY_FAMILY_NO_SERIES:${vk}:${family.family}`);
      } else {
        const newestCount = family.series.filter(series => series && series.generation_state === 'newest').length;
        const previousCount = family.series.filter(series => series && series.generation_state === 'previous').length;
        if (newestCount !== 1 || previousCount > 1) {
          errors.push(`SERIES_POLICY_GENERATION_STATE_INVALID:${vk}:${family.family}:newest=${newestCount},previous=${previousCount}`);
        }
        for (const series of family.series) {
          if (!series || typeof series.id !== 'string' || !series.id) errors.push(`SERIES_POLICY_SERIES_ID_INVALID:${vk}:${family.family}`);
          if (series.id && seenSeriesId.has(series.id)) errors.push(`SERIES_POLICY_SERIES_DUPLICATE:${series.id}`);
          if (series.id) seenSeriesId.add(series.id);
          if (typeof series.title !== 'string' || !series.title) errors.push(`SERIES_POLICY_SERIES_TITLE_INVALID:${series.id || vk}`);
          if (!GENERATION_STATES.includes(series.generation_state)) errors.push(`SERIES_POLICY_SERIES_GENERATION_STATE_INVALID:${series.id || vk}:${series.generation_state}`);
          if (!Array.isArray(series.expected_members)) errors.push(`SERIES_POLICY_SERIES_MEMBERS_INVALID:${series.id || vk}`);
          for (const member of series.expected_members || []) {
            if (detailKeyOf(member) === null) errors.push(`SERIES_POLICY_SERIES_MEMBER_KEY_INVALID:${series.id || vk}:${member}`);
          }
        }
      }

      const ev = family.evidence;
      if (!ev || typeof ev !== 'object' || !EVIDENCE_STATUS.includes(ev.status)) {
        errors.push(`SERIES_POLICY_EVIDENCE_INVALID:${vk}:${family.family}`);
      }
      if (ev && typeof ev.url !== 'string' && typeof ev.title !== 'string') {
        errors.push(`SERIES_POLICY_EVIDENCE_URL_INVALID:${vk}:${family.family}`);
      }
      if (ev && ev.member_status) {
        for (const [key, status] of Object.entries(ev.member_status)) {
          if (!EVIDENCE_STATUS.includes(status)) errors.push(`SERIES_POLICY_EVIDENCE_MEMBER_STATUS_INVALID:${vk}:${key}:${status}`);
        }
      }
    }
  }
  return errors;
}

function loadSeriesPolicy(filePath) {
  const policy = readSeriesPolicy(filePath);
  const errors = validateSeriesPolicy(policy);
  if (errors.length) throw new Error(`SERIES_POLICY_INVALID:${errors.join(',')}`);
  return policy;
}

function normalizeVendorKey(policy, value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (policy.vendors.some(v => v.vendor_key === text)) return text;
  for (const [canonical, aliases] of Object.entries(policy.vendor_aliases || {})) {
    if (canonical === text) return canonical;
    if (Array.isArray(aliases) && aliases.some(alias => String(alias).toLowerCase() === text)) return canonical;
  }
  return null;
}

function policyForVendor(policy, vendorKey) {
  const key = String(vendorKey || '').trim().toLowerCase();
  return policy.vendors.find(v => v.vendor_key === key) || null;
}

function matchFamily(policy, vendorPolicy, modelName) {
  if (!vendorPolicy) return null;
  const name = String(modelName || '').toLowerCase();
  for (const family of vendorPolicy.families) {
    const patterns = family.name_patterns;
    if (!Array.isArray(patterns) || !patterns.length) continue;
    if (patterns.some(p => name.includes(String(p).toLowerCase()))) {
      return { family: family.family, source: 'pattern', usage_kind: family.usage_kind };
    }
  }
  return null;
}

function usageFromModality(modality) {
  if (modality === 'video') return 'video';
  if (modality === 'image') return 'image';
  if (modality === 'audio') return 'audio_realtime';
  if (modality === 'text') return 'general_llm';
  return null;
}

function usageKindOf(policy, vendorPolicy, seed) {
  if (!seed?.detail_kind || !seed?.name) return 'unknown';
  if (seed.detail_kind === 'subscription_plan') return 'subscription';
  if (seed.detail_kind === 'tool') {
    const matched = matchFamily(policy, vendorPolicy, seed.name);
    return matched ? matched.usage_kind : 'tool';
  }

  const matched = matchFamily(policy, vendorPolicy, seed.name);
  if (matched) return matched.usage_kind;

  if (seed.modality) {
    const usage = usageFromModality(seed.modality);
    if (usage) return usage;
  }

  if (vendorPolicy) {
    const defaultFamily = vendorPolicy.families.find(f => f.usage_kind === 'general_llm');
    if (defaultFamily) return 'general_llm';
    return 'uncovered';
  }
  return 'uncovered';
}

function allowedTargetSeries(policy, vendorPolicy, familyKey) {
  if (!vendorPolicy) return [];
  const family = vendorPolicy.families.find(f => f.family === familyKey);
  return family ? family.series : [];
}

function validatePlacementRef(policy, snapshotInput, placement, vendorKey) {
  const violations = [];
  const snapshot = snapshotInput || emptySnapshot();
  const plac = placement || {};

  const level1 = plac.existing_level1_ref;
  if (level1 !== undefined && level1 !== null) {
    const targetKind = REF_TARGETS['vendor-card.level1_ref'];
    if (!level1 || level1.kind !== targetKind) violations.push(`PLACEMENT_L1_KIND_INVALID:${level1 && level1.id}`);
    else {
      const found = (snapshot['vendor-level1'] || []).find(x => x.id === level1.id);
      if (!found) violations.push(`PLACEMENT_L1_NOT_FOUND:${level1.id}`);
      else if (vendorKey && found.vendor_key && found.vendor_key !== vendorKey) violations.push(`PLACEMENT_L1_VENDOR_MISMATCH:${level1.id}`);
    }
  }

  const level2 = plac.existing_level2_ref;
  if (level2 !== undefined && level2 !== null) {
    const targetKind = REF_TARGETS['vendor-level1.level2_refs'];
    if (!level2 || level2.kind !== targetKind) violations.push(`PLACEMENT_L2_KIND_INVALID:${level2 && level2.id}`);
    else {
      const found = (snapshot['vendor-level2'] || []).find(x => x.id === level2.id);
      if (!found) violations.push(`PLACEMENT_L2_NOT_FOUND:${level2.id}`);
      else if (vendorKey && found.vendor_key && found.vendor_key !== vendorKey) violations.push(`PLACEMENT_L2_VENDOR_MISMATCH:${level2.id}`);
    }
  }

  return { ok: violations.length === 0, violations };
}

function groupKeyOfSeriesId(seriesId) {
  const parts = String(seriesId || '').split(':');
  return parts[parts.length - 1] || null;
}

function brandHintsOfFamily(familyDef) {
  const hints = [String(familyDef.family || '')];
  for (const series of familyDef.series || []) {
    for (const word of String(series.title || '').split(/\s+/)) if (word && word.length >= 2) hints.push(word);
    for (const member of series.expected_members || []) {
      const key = detailKeyOf(member);
      if (key && key.length >= 2) hints.push(key);
    }
  }
  return [...new Set(hints.map(h => h.toLowerCase()).filter(h => h.length >= 2))];
}

function planSeriesPlacement(policy, snapshot, candidate, hint) {
  // 1. 厂商归一化：无政策厂商 → 现有路径
  const vendorKey = normalizeVendorKey(policy, candidate.vendor_key || candidate.vendor_name);
  if (!vendorKey) return { kind: 'not_applicable', reason: 'VENDOR_NOT_IN_POLICY' };
  const vendorPolicy = policyForVendor(policy, vendorKey);
  if (!vendorPolicy) return { kind: 'not_applicable', reason: 'VENDOR_NOT_IN_POLICY' };
  const generalFamilies = vendorPolicy.families.filter(f => f.usage_kind === 'general_llm');

  // 2. 用途/家族判定：pattern 命中（任意家族）/ 显式 modality / AI hint 均视为高置信；
  //    无任何品牌命中的“默认通用”属歧义，交由 AI 或人工确认。
  const lowerName = String(candidate.name || '').toLowerCase();
  const matched = matchFamily(policy, vendorPolicy, candidate.name);
  const modalityUsage = candidate.modality ? usageFromModality(candidate.modality) : null;
  const brandFamily = generalFamilies.find(gf => brandHintsOfFamily(gf).some(h => lowerName.includes(h)))?.family || null;
  const hintUsage = hint && VALID_USAGE_KIND_FOR_PLACEMENT.includes(hint.usage_kind) ? hint.usage_kind : null;

  let usage = matched?.usage_kind || modalityUsage || hintUsage || (brandFamily ? 'general_llm' : null);
  const confident = Boolean(matched || modalityUsage || hintUsage || brandFamily);

  if (!usage) {
    if (generalFamilies.length) { usage = 'general_llm'; } // 默认通用（歧义，见下）
    else return { kind: 'needs_ai', reason: 'USAGE_UNCOVERED' };
  }
  if (usage === 'uncovered' || usage === 'unknown') return { kind: 'needs_ai', reason: `USAGE_UNKNOWN:${usage}` };
  if (!confident) return { kind: 'needs_ai', reason: 'USAGE_AMBIGUOUS_DEFAULT' };

  // 3. 家族判定：pattern 命中优先；其次 hint 指定家族；再次 modality 同族；再次通用品牌；最后通用默认
  let family = matched?.family || null;
  if (!family && hint?.canonical_family) {
    const hinted = vendorPolicy.families.find(f => f.family === hint.canonical_family);
    if (hinted && (hinted.usage_kind === usage || !matched)) family = hint.canonical_family;
  }
  if (!family && candidate.modality) {
    family = vendorPolicy.families.find(f => f.modality === candidate.modality)?.family || null;
  }
  if (!family) family = brandFamily;
  if (!family) {
    const usageFamily = vendorPolicy.families.find(f => f.usage_kind === usage);
    if (usageFamily) family = usageFamily.family;
  }
  if (!family) {
    const generalFamily = generalFamilies[0];
    if (!generalFamily) return { kind: 'fail_closed', code: 'PLACEMENT_NO_GENERAL_FAMILY', vendor: vendorKey };
    family = generalFamily.family;
  }
  const familyDef = vendorPolicy.families.find(f => f.family === family);
  if (!familyDef) {
    return { kind: 'fail_closed', code: 'PLACEMENT_FAMILY_NOT_IN_POLICY', vendor: vendorKey, family };
  }
  usage = familyDef.usage_kind;

  // 4. 目标系列：按 generation_state 选目标（AI hint 的 release_cohort 作软提示）
  const seriesList = allowedTargetSeries(policy, vendorPolicy, family);
  if (!seriesList.length) return { kind: 'fail_closed', code: 'PLACEMENT_NO_SERIES', vendor: vendorKey, family };
  const wantedState = hint?.release_cohort === 'previous' ? 'previous' : 'newest';
  const target = seriesList.find(s => s.generation_state === wantedState)
    || seriesList.find(s => s.generation_state === 'newest')
    || seriesList[0];

  // 5. 结构对齐检查：目标不在快照，且同厂商存在占用政策成员的非政策系列 → 需迁移对齐
  const exists = (snapshot['vendor-level2'] || []).some(l2 => l2.id === target.id);
  if (!exists) {
    const targetMemberIds = new Set((target.expected_members || []).map(memberRef => detailKeyOf(memberRef)).filter(Boolean));
    const allPolicyTargetIds = new Set(vendorPolicy.families.flatMap(f => (f.series || []).map(s => s.id)));
    const misaligned = (snapshot['vendor-level2'] || []).some(l2 => l2.vendor_key === vendorKey
      && !allPolicyTargetIds.has(l2.id)
      && (l2.detail_refs || []).some(ref => targetMemberIds.has(detailKeyOf(ref.id))));
    if (misaligned) {
      return {
        kind: 'migration_required',
        code: 'SERIES_MIGRATION_REQUIRED',
        vendor: vendorKey,
        family,
        series: target,
        reason: `目标系列 ${target.id} 不在快照，且存在占用政策成员的旧系列，需先运行迁移 CLI 对齐`,
      };
    }
  }

  return {
    kind: 'decision',
    vendor: vendorKey,
    family,
    usage_kind: usage,
    generation_state: target.generation_state,
    release_cohort: target.generation_state,
    target_mode: exists ? 'existing' : 'create',
    target_level2_id: target.id,
    target_level2_title: target.title,
    group_key: groupKeyOfSeriesId(target.id),
    source: hint ? 'ai' : 'policy',
    confidence: hint ? (hint.confidence ?? 1) : 1,
    evidence: [target.id],
  };
}
const VALID_USAGE_KIND_FOR_PLACEMENT = Object.freeze([
  'general_llm', 'coding', 'image', 'video', 'audio_realtime',
  'translation', 'omni', 'media', 'tool', 'subscription',
]);

module.exports = {
  readSeriesPolicy,
  validateSeriesPolicy,
  loadSeriesPolicy,
  normalizeVendorKey,
  policyForVendor,
  matchFamily,
  usageKindOf,
  allowedTargetSeries,
  validatePlacementRef,
  planSeriesPlacement,
  detailKeyOf,
  detailRefIdOf,
};

