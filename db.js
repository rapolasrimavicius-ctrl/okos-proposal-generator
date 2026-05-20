// db.js — Supabase client, session state, and proposal/event CRUD.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

let _client = null;
let _user = null;
let _session = null;

export function initSupabase() {
  if (_client) return _client;
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return _client;
}

export function getSupabase() { return _client; }
export function getCurrentUser() { return _user; }
export function getCurrentSession() { return _session; }
export function setSession(session) {
  _session = session ?? null;
  _user = session?.user ?? null;
}

// ── Proposal CRUD ─────────────────────────────────────────────────────

/**
 * Insert a fresh proposal row for the current user.
 * Returns the inserted row (with id).
 */
export async function createProposal(initial = {}) {
  const user = getCurrentUser();
  if (!user) throw new Error('not_signed_in');
  const row = {
    user_id: user.id,
    status: 'draft',
    client_name: initial.client_name ?? null,
    project_code: initial.project_code ?? null,
    facility_name: initial.facility_name ?? null,
    project_address: initial.project_address ?? null,
    date_field: initial.date_field ?? null,
    revision: initial.revision ?? null,
    snapshot: initial.snapshot ?? {},
  };
  const { data, error } = await _client.from('proposals').insert(row).select().single();
  if (error) throw error;
  return data;
}

/**
 * Update an existing proposal — merges header fields + snapshot.
 */
export async function updateProposal(id, patch) {
  const { error } = await _client.from('proposals').update(patch).eq('id', id);
  if (error) throw error;
}

export async function markExported(id, filename) {
  const { error } = await _client.from('proposals').update({
    status: 'exported',
    last_exported_at: new Date().toISOString(),
    last_exported_filename: filename,
  }).eq('id', id);
  if (error) throw error;
}

export async function listProposals({ search = '' } = {}) {
  let q = _client.from('proposals')
    .select('id, created_at, updated_at, status, client_name, project_code, last_exported_at, last_exported_filename')
    .order('updated_at', { ascending: false })
    .limit(200);

  if (search.trim()) {
    const s = `%${search.trim()}%`;
    q = q.or(`client_name.ilike.${s},project_code.ilike.${s}`);
  }
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function getProposal(id) {
  const { data, error } = await _client.from('proposals').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function deleteProposal(id) {
  const { error } = await _client.from('proposals').delete().eq('id', id);
  if (error) throw error;
}

// ── Events ─────────────────────────────────────────────────────────────

export async function listEvents({ level = 'all', limit = 50, before = null } = {}) {
  let q = _client.from('events')
    .select('id, created_at, level, type, message, context, proposal_id')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (level !== 'all') q = q.eq('level', level);
  if (before) q = q.lt('created_at', before);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// Pull client_name + project_code for a set of proposal ids in one round-trip.
export async function fetchProposalLabels(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const { data, error } = await _client.from('proposals')
    .select('id, client_name, project_code')
    .in('id', unique);
  if (error) {
    console.warn('fetchProposalLabels failed:', error.message);
    return {};
  }
  const out = {};
  for (const row of data ?? []) out[row.id] = row;
  return out;
}

// ── Snapshot helpers ──────────────────────────────────────────────────

/**
 * Serialize wizard state into a snapshot suitable for the snapshot jsonb column.
 * Strips drawing binaries — only metadata is retained.
 */
export function buildSnapshotFromCollect(data) {
  const drawingsMeta = (data.drawings || []).map(d => ({ name: d.name, type: d.type }));
  return {
    ...data,
    drawings: drawingsMeta,
  };
}

/**
 * Restore wizard state from a snapshot. Requires the wizard JS globals on window.
 * Drawings cannot be restored (binaries were stripped); the drawings list is cleared.
 */
export function restoreSnapshot(snapshot) {
  if (!snapshot) return;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? '';
  };

  // Header fields
  setVal('clientName',       snapshot.clientName);
  setVal('projectCode',      snapshot.projectCode);
  setVal('facilityName',     snapshot.facilityName);
  setVal('projectLocation',  snapshot.projectLocation);
  setVal('proposalDate',     snapshot.date);
  setVal('revision',         snapshot.revision === '—' ? '' : snapshot.revision);

  // AI fields
  setVal('execOverview',       snapshot.execOverview);
  setVal('projectOverview',    snapshot.projectOverview);
  setVal('sysArch',            snapshot.sysArch);
  setVal('techConsiderations', snapshot.techConsiderations);
  setVal('aiDependencies',     snapshot.aiDependencies);
  setVal('aiConclusion',       snapshot.aiConclusion);

  // Others
  setVal('permitting',       snapshot.permitting);
  setVal('lift',             snapshot.lift);
  setVal('bulky',            snapshot.bulky);
  setVal('additionalNotes',  snapshot.notes);

  // Scope rows
  ['okosScope', 'clientScope', 'assumptions'].forEach(containerId => {
    const c = document.getElementById(containerId);
    if (c) c.innerHTML = '';
  });
  // Reset wizard counters (defined on the inline wizard script)
  if (typeof window.okosScopeCount === 'number')   window.okosScopeCount = 0;
  if (typeof window.clientScopeCount === 'number') window.clientScopeCount = 0;
  if (typeof window.assumptionCount === 'number')  window.assumptionCount = 0;

  (snapshot.okosScope || []).forEach(t => window.addScope?.('okos', t));
  (snapshot.clientScope || []).forEach(t => window.addScope?.('client', t));
  (snapshot.assumptions || []).forEach(t => window.addScope?.('assumption', t));

  // Material rows
  document.getElementById('okosMats')?.replaceChildren();
  document.getElementById('clientMats')?.replaceChildren();
  if (typeof window.okosMatCount === 'number')   window.okosMatCount = 0;
  if (typeof window.clientMatCount === 'number') window.clientMatCount = 0;

  (snapshot.okosMats || []).forEach(m => window.addMat?.('okos', m));
  (snapshot.clientMats || []).forEach(m => window.addMat?.('client', m));

  // Drawings cannot be restored — binaries weren't stored
  if (Array.isArray(window.drawings)) window.drawings.length = 0;
  window.renderDrawings?.();
  window._locBomData = snapshot.locBomData || [];

  window.updateTotal?.();
  window.updateMatTableState?.();
}
