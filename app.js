// app.js — orchestrator. Initializes auth, exposes window.Okos for the inline wizard
// to hook into (logging, proposal save, BOM/AI/export events), and manages the
// History view + toast notifications.

import { startAuth } from './auth.js';
import {
  initSupabase, getSupabase, getCurrentUser,
  createProposal, updateProposal, markExported,
} from './db.js';
import { logEvent } from './logger.js';
import * as gemini from './gemini.js';
import { mountHistory, refreshHistory } from './history.js';
import { buildSnapshotFromCollect } from './db.js';

// ── State ───────────────────────────────────────────────────────────────
const state = {
  proposalId: null,
  dirty: false,
  saveTimer: null,
  view: 'wizard',  // 'wizard' | 'history'
  historyMounted: false,
};

// ── Boot ────────────────────────────────────────────────────────────────
initSupabase();
exposeApi();
attachWizardListeners();
mountHistoryToggle();

startAuth({
  onSignedIn: () => {
    // Reset per-session state
    state.proposalId = null;
    state.dirty = false;
  },
  onSignedOut: () => {
    state.proposalId = null;
    if (state.view === 'history') showWizard();
  },
});

// ── Public API surface for the inline wizard ────────────────────────────
function exposeApi() {
  window.Okos = {
    log: logEvent,
    toast,
    onBomImported,
    onBomImportFailed,
    onAiGenerated,
    onAiFailed,
    onExportSucceeded,
    onExportFailed,
    gemini,
    getProposalId: () => state.proposalId,
    ensureProposal,
    saveSnapshotDebounced,
    isReady: () => !!getCurrentUser(),
  };
}

// ── Proposal lifecycle ──────────────────────────────────────────────────

async function ensureProposal(reason = 'edit') {
  if (state.proposalId) return state.proposalId;
  if (!getCurrentUser()) return null;
  try {
    const collect = window.collectData?.() ?? {};
    const snapshot = buildSnapshotFromCollect(collect);
    const row = await createProposal({
      client_name:      collect.clientName || null,
      project_code:     collect.projectCode || null,
      facility_name:    collect.facilityName || null,
      project_address:  collect.projectLocation || null,
      date_field:       collect.date || null,
      revision:         collect.revision || null,
      snapshot,
    });
    state.proposalId = row.id;
    logEvent({ level: 'info', type: 'proposal.created', message: 'New proposal started', proposalId: row.id, context: { reason } });
    return row.id;
  } catch (err) {
    logEvent({ level: 'warn', type: 'warn.persistence', message: err?.message || 'create failed', context: { operation: 'create', table: 'proposals' } });
    toast({ level: 'warn', message: 'Could not save to history.' });
    return null;
  }
}

function saveSnapshotDebounced() {
  if (!getCurrentUser()) return;
  state.dirty = true;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveSnapshotNow, 800);
}

async function saveSnapshotNow() {
  if (!getCurrentUser()) return;
  if (!state.dirty) return;
  const id = await ensureProposal('autosave');
  if (!id) return;
  state.dirty = false;
  try {
    const collect = window.collectData?.() ?? {};
    const snapshot = buildSnapshotFromCollect(collect);
    await updateProposal(id, {
      client_name:      collect.clientName || null,
      project_code:     collect.projectCode || null,
      facility_name:    collect.facilityName || null,
      project_address:  collect.projectLocation || null,
      date_field:       collect.date || null,
      revision:         collect.revision || null,
      snapshot,
    });
  } catch (err) {
    logEvent({ level: 'warn', type: 'warn.persistence', message: err?.message || 'update failed', context: { operation: 'update', table: 'proposals' } });
  }
}

// ── Trigger hooks for the inline wizard ─────────────────────────────────

async function onBomImported({ filename, itemCount, sheetNames }) {
  const id = await ensureProposal('bom_import');
  await saveSnapshotNow(); // immediate save once the BOM lands
  logEvent({
    level: 'info', type: 'bom.imported',
    message: `BOM imported: ${filename}`,
    context: { filename, item_count: itemCount, sheet_names: sheetNames },
    proposalId: id,
  });
}

function onBomImportFailed({ filename, stage, message }) {
  logEvent({
    level: 'error', type: 'error.bom_parse',
    message: message || 'BOM parse failed',
    context: { filename, stage },
    proposalId: state.proposalId,
  });
  toast({ level: 'error', message: message || 'Could not parse BOM.' });
}

function onAiGenerated({ sections, model }) {
  logEvent({
    level: 'info', type: 'ai.generated',
    message: `AI generated ${sections.length} sections`,
    context: { sections, model },
    proposalId: state.proposalId,
  });
}

function onAiFailed({ status, code, endpoint, message }) {
  logEvent({
    level: 'error', type: 'error.gemini',
    message: message || 'Gemini call failed',
    context: { status, code, endpoint },
    proposalId: state.proposalId,
  });
  toast({ level: 'error', message: message || 'AI generation failed.' });
}

async function onExportSucceeded({ filename, sizeBytes }) {
  const id = await ensureProposal('export');
  if (id) {
    try { await markExported(id, filename); }
    catch (err) {
      logEvent({ level: 'warn', type: 'warn.persistence', message: err?.message || 'markExported failed', context: { operation: 'update', table: 'proposals' } });
    }
  }
  await saveSnapshotNow();
  logEvent({
    level: 'info', type: 'proposal.exported',
    message: `Exported ${filename}`,
    context: { filename, size_bytes: sizeBytes },
    proposalId: id,
  });
}

function onExportFailed({ stage, message }) {
  logEvent({
    level: 'error', type: 'error.docx_export',
    message: message || 'DOCX export failed',
    context: { stage },
    proposalId: state.proposalId,
  });
  toast({ level: 'error', message: message || 'DOCX export failed.' });
}

// ── Wizard edit listeners (debounced auto-save) ─────────────────────────

function attachWizardListeners() {
  // Wait until DOM is ready
  const wire = () => {
    const reviewPanel = document.getElementById('panel-1');
    if (!reviewPanel) return;
    reviewPanel.addEventListener('input', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) return;
      if (t.id === 'loginEmail' || t.id === 'histSearch') return; // not part of the wizard
      saveSnapshotDebounced();
    });
    reviewPanel.addEventListener('change', () => saveSnapshotDebounced());
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
}

// ── History view toggle ─────────────────────────────────────────────────

function mountHistoryToggle() {
  const handler = () => {
    const link = document.getElementById('headerHistoryLink');
    if (!link) return;
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (state.view === 'history') showWizard();
      else showHistory();
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', handler);
  else handler();
}

function showHistory() {
  state.view = 'history';
  document.body.classList.remove('app-state-app');
  document.body.classList.add('app-state-history');
  const container = document.getElementById('historyView');
  if (!container) return;
  if (!state.historyMounted) {
    mountHistory({
      container,
      onOpenProposal: (row) => {
        state.proposalId = row.id;
        state.dirty = false;
        showWizard();
        // Jump to Review & Edit step in the wizard
        window.goTo?.(1);
      },
      onBack: () => showWizard(),
    });
    state.historyMounted = true;
  } else {
    refreshHistory();
  }
  document.getElementById('headerHistoryLink')?.classList.add('active');
}

function showWizard() {
  state.view = 'wizard';
  document.body.classList.remove('app-state-history');
  document.body.classList.add('app-state-app');
  document.getElementById('headerHistoryLink')?.classList.remove('active');
}

// ── Toast ───────────────────────────────────────────────────────────────

let toastTimer = null;
function toast({ level = 'info', message }) {
  let host = document.getElementById('appToast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'appToast';
    host.className = 'app-toast';
    document.body.appendChild(host);
  }
  host.className = 'app-toast app-toast-' + level + ' show';
  host.innerHTML = `<span>${escText(message)}</span><button class="app-toast-close" type="button" aria-label="Dismiss">×</button>`;
  host.querySelector('.app-toast-close').addEventListener('click', () => host.classList.remove('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => host.classList.remove('show'), 6000);
}

function escText(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
