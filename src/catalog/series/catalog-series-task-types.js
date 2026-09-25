'use strict';

function normalizeTaskType(value, registry) {
  const text = String(value || '').trim().toLocaleLowerCase('en-US').normalize('NFKC');
  if (!text || !registry || typeof registry !== 'object') return null;
  for (const [canonical, definition] of Object.entries(registry)) {
    if (canonical.toLocaleLowerCase('en-US') === text) return canonical;
    if ((definition.aliases || []).some(alias => String(alias).trim().toLocaleLowerCase('en-US').normalize('NFKC') === text)) return canonical;
  }
  return null;
}

function normalizeTaskTypes(values, registry) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) return null;
  const normalized = [];
  for (const value of values) {
    const taskType = normalizeTaskType(value, registry);
    if (!taskType) return null;
    if (!normalized.includes(taskType)) normalized.push(taskType);
  }
  return normalized;
}

function taskTypesFromName(value, registry) {
  const text = String(value || '').toLocaleLowerCase('en-US').normalize('NFKC').replace(/[_./-]+/g, ' ');
  const result = [];
  for (const [canonical, definition] of Object.entries(registry || {})) {
    const aliases = [canonical, ...(definition.aliases || [])];
    if (aliases.some(alias => {
      const token = String(alias).toLocaleLowerCase('en-US').normalize('NFKC').replace(/[_./-]+/g, ' ').trim();
      if (token.length < 3) return false;
      return new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?:$|\\s)`, 'i').test(text);
    })) result.push(canonical);
  }
  return result;
}

function taskTypesForMember(name, familyTaskTypes, registry) {
  const familyTypes = Array.isArray(familyTaskTypes) ? familyTaskTypes : [];
  const inferred = taskTypesFromName(name, registry).filter(type => familyTypes.includes(type));
  return inferred.length ? inferred : familyTypes.length === 1 ? [...familyTypes] : [];
}

function usageKindForTaskTypes(taskTypes, registry) {
  const usages = [...new Set((taskTypes || []).map(type => registry?.[type]?.usage_kind).filter(Boolean))];
  return usages.length === 1 ? usages[0] : null;
}

function familyForTaskTypes(vendorPolicy, taskTypes, hintedFamily) {
  if (!taskTypes?.length || !vendorPolicy) return null;
  const hinted = vendorPolicy.families.find(family => family.family === hintedFamily && taskTypes.every(type => family.task_types?.includes(type)));
  if (hinted) return hinted;
  const matches = vendorPolicy.families.filter(family => taskTypes.every(type => family.task_types?.includes(type)));
  if (!matches.length) return null;
  const smallest = Math.min(...matches.map(family => family.task_types.length));
  const mostSpecific = matches.filter(family => family.task_types.length === smallest);
  return mostSpecific.length === 1 ? mostSpecific[0] : null;
}

function familyForModality(vendorPolicy, modality) {
  const matches = (vendorPolicy?.families || []).filter(family => family.modality === modality || family.modality === 'omni');
  return matches.length === 1 ? { family: matches[0] } : { ambiguous: matches.length > 1, unsupported: matches.length === 0 };
}

function modalityMatches(familyModality, candidateModality) {
  return !candidateModality || familyModality === candidateModality || familyModality === 'omni';
}

function taskTypesFitFamily(taskTypes, family) {
  return !taskTypes?.length || !Array.isArray(family?.task_types) || taskTypes.every(type => family.task_types.includes(type));
}

function resolveTaskTypePlacement(policy, vendorPolicy, candidate, hint, matched) {
  const explicitTypes = candidate.task_types?.length ? candidate.task_types : hint?.task_types?.length ? hint.task_types : null;
  const matchedFamily = matched && vendorPolicy.families.find(family => family.family === matched.family);
  const inferredTypes = explicitTypes || taskTypesFromName(candidate.name, policy.task_type_registry);
  const declaredTypes = !explicitTypes && Array.isArray(matchedFamily?.task_types)
    ? inferredTypes.filter(type => matchedFamily.task_types.includes(type))
    : inferredTypes;
  const taskTypes = normalizeTaskTypes(declaredTypes, policy.task_type_registry);
  const vendor = vendorPolicy.vendor_key;
  if (!taskTypes) return { error: { kind: 'fail_closed', code: 'PLACEMENT_TASK_TYPES_INVALID', vendor } };
  const family = familyForTaskTypes(vendorPolicy, taskTypes, hint?.canonical_family);
  if (taskTypes.length && !family && !matched) {
    return { error: { kind: 'fail_closed', code: 'PLACEMENT_TASK_TYPE_UNSUPPORTED', vendor, task_types: taskTypes } };
  }
  if (matched && !taskTypesFitFamily(taskTypes, vendorPolicy.families.find(item => item.family === matched.family))) {
    return { error: { kind: 'fail_closed', code: 'PLACEMENT_TASK_TYPE_FAMILY_MISMATCH', vendor, family: matched.family, task_types: taskTypes } };
  }
  return { taskTypes, family, usageKind: usageKindForTaskTypes(taskTypes, policy.task_type_registry) };
}

function validateResolvedTaskTypes(taskTypes, family, modality, vendor) {
  if (!modalityMatches(family.modality, modality)) {
    return { kind: 'fail_closed', code: 'PLACEMENT_MODALITY_FAMILY_MISMATCH', vendor, family: family.family, modality };
  }
  if (!taskTypesFitFamily(taskTypes, family)) {
    return { kind: 'fail_closed', code: 'PLACEMENT_TASK_TYPE_FAMILY_MISMATCH', vendor, family: family.family, task_types: taskTypes };
  }
  return null;
}

function validateFamilyTaskTypes(vendorKey, family, registry) {
  if (family.task_types === undefined) {
    return family.series_kind === 'model_series' ? [`SERIES_POLICY_TASK_TYPES_REQUIRED:${vendorKey}:${family.family}`] : [];
  }
  if (!Array.isArray(family.task_types)) return [`SERIES_POLICY_TASK_TYPES_INVALID:${vendorKey}:${family.family}`];
  const errors = [];
  const seen = new Set();
  for (const type of family.task_types) {
    if (!Object.hasOwn(registry || {}, type)) errors.push(`SERIES_POLICY_TASK_TYPE_UNKNOWN:${vendorKey}:${family.family}:${type}`);
    if (seen.has(type)) errors.push(`SERIES_POLICY_TASK_TYPE_DUPLICATE:${vendorKey}:${family.family}:${type}`);
    seen.add(type);
  }
  return errors;
}

function validateTaskTypeRegistry(registry, usageKinds) {
  const errors = [];
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || !Object.keys(registry).length) {
    return ['SERIES_POLICY_TASK_TYPE_REGISTRY_INVALID'];
  }
  for (const [label, definition] of Object.entries(registry)) {
    if (!label.trim() || !definition || typeof definition !== 'object' || Array.isArray(definition)) {
      errors.push(`SERIES_POLICY_TASK_TYPE_INVALID:${label}`);
      continue;
    }
    if (!Array.isArray(definition.aliases) || definition.aliases.some(alias => typeof alias !== 'string' || !alias.trim())) {
      errors.push(`SERIES_POLICY_TASK_TYPE_ALIASES_INVALID:${label}`);
    }
    if (!usageKinds.includes(definition.usage_kind)) errors.push(`SERIES_POLICY_TASK_TYPE_USAGE_INVALID:${label}:${definition.usage_kind}`);
  }
  return errors;
}

module.exports = {
  normalizeTaskType,
  normalizeTaskTypes,
  taskTypesFromName,
  taskTypesForMember,
  usageKindForTaskTypes,
  familyForTaskTypes,
  familyForModality,
  modalityMatches,
  taskTypesFitFamily,
  resolveTaskTypePlacement,
  validateResolvedTaskTypes,
  validateFamilyTaskTypes,
  validateTaskTypeRegistry,
};
