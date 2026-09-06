'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { readJson, writeJsonAtomic, acquireLock, releaseLock } = require('../../shared/json-store');

const BUNDLE_PREPARE_LOCK_TTL_MS = 15 * 60 * 1000;

function ensureDraftDir() {
  fs.mkdirSync(CATALOG_GENERATOR_FILES.draftsDir, { recursive: true });
}

function bundlePrepareLockPath() {
  return path.join(CATALOG_GENERATOR_FILES.draftsDir, '.series-bundle-prepare.lock');
}

function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function staleBundlePrepareLock(lock) {
  const pid = Number(lock?.pid);
  const started = Date.parse(lock?.started_at || lock?.acquired_at || '');
  return Number.isFinite(started)
    && Date.now() - started > BUNDLE_PREPARE_LOCK_TTL_MS
    && !ownerAlive(pid);
}

function recoverStaleBundlePrepareLock(lockPath) {
  const current = readJson(lockPath, null);
  if (!staleBundlePrepareLock(current)) return false;
  const currentAgain = readJson(lockPath, null);
  if (!currentAgain || currentAgain.run_id !== current.run_id || currentAgain.pid !== current.pid
    || currentAgain.started_at !== current.started_at) return false;
  const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(lockPath, stalePath);
    try { fs.unlinkSync(stalePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    return false;
  }
}

function acquireBundlePrepareLock() {
  ensureDraftDir();
  const lockPath = bundlePrepareLockPath();
  const runId = `series-bundle-${process.pid}-${Date.now()}`;
  const metadata = {
    owner: runId,
    run_id: runId,
    pid: process.pid,
    started_at: new Date().toISOString(),
  };
  try { acquireLock(lockPath, metadata); }
  catch (error) {
    if (error.code !== 'EEXIST' || !recoverStaleBundlePrepareLock(lockPath)) throw error;
    acquireLock(lockPath, metadata);
  }
  return { lockPath, runId };
}

function releaseBundlePrepareLock(lock) {
  return releaseLock(lock.lockPath, lock.runId);
}

function newDraftId() {
  return `draft-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
}

function draftPath(draftId) {
  if (!/^draft-[A-Za-z0-9-]+$/.test(String(draftId || ''))) throw new Error('DRAFT_ID_INVALID');
  return path.join(CATALOG_GENERATOR_FILES.draftsDir, `${draftId}.json`);
}

function readDraft(draftId) {
  return readJson(draftPath(draftId));
}

function writeDraft(draft, runId = 'catalog-draft') {
  if (!draft?.draft_id) throw new Error('DRAFT_ID_REQUIRED');
  ensureDraftDir();
  const value = { ...draft, updated_at: new Date().toISOString() };
  writeJsonAtomic(draftPath(value.draft_id), value, runId);
  return value;
}

function createDraft(input) {
  const draft = {
    schema_version: input?.schema_version || 3,
    draft_id: input?.draft_id || newDraftId(),
    state: input?.state || 'researching',
    created_at: input?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    base_revision: input?.base_revision || null,
    seed: input?.seed || {},
    research: input?.research || { ok: false, official_sources: [], warnings: [] },
    research_progress: input?.research_progress || null,
    research_plan: input?.research_plan || null,
    coverage: input?.coverage || null,
    layer_patches: input?.layer_patches || [],
    synthesis: input?.synthesis || null,
    record_preview: input?.record_preview || null,
    cost: input?.cost || null,
    readiness: input?.readiness || { status: 'blocked', blocking_reasons: [], warnings: [] },
    change_preview: input?.change_preview || null,
    preview_hash: input?.preview_hash || null,
    bundle: input?.bundle || null,
    bundle_token: input?.bundle_token || null,
    bundle_id: input?.bundle_id || null,
    draft_kind: input?.draft_kind || 'catalog',
    apply_checkpoint: input?.apply_checkpoint || null,
    recovery_checkpoint: input?.recovery_checkpoint || null,
    last_error: input?.last_error || null,
  };
  return writeDraft(draft, 'catalog-draft-create');
}

function updateDraft(draftId, patch, runId = 'catalog-draft-update') {
  return writeDraft({ ...readDraft(draftId), ...patch, draft_id: draftId }, runId);
}

function deleteDraft(draftId) {
  const file = draftPath(draftId);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function listDrafts(options = {}) {
  ensureDraftDir();
  const schemaVersion = options.include_all === true ? null : (options.schema_version ?? 3);
  const draftKind = options.include_all === true ? null : (options.draft_kind || 'catalog');
  return fs.readdirSync(CATALOG_GENERATOR_FILES.draftsDir)
    .filter(file => file.endsWith('.json'))
    .map(file => readDraft(file.slice(0, -5)))
    .filter(draft => (schemaVersion === null || draft.schema_version === schemaVersion)
      && (draftKind === null || draft.draft_kind === draftKind));
}

module.exports = { newDraftId, draftPath, readDraft, writeDraft, createDraft, updateDraft, deleteDraft, listDrafts, acquireBundlePrepareLock, releaseBundlePrepareLock };
