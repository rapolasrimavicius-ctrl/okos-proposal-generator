// history.js — History view with Proposals + Activity tabs.

import {
  listProposals, listEvents, getProposal, deleteProposal,
  fetchProposalLabels, restoreSnapshot,
} from './db.js';
import { logEvent } from './logger.js';

const PAGE_SIZE = 50;

const state = {
  tab: 'proposals',       // 'proposals' | 'activity'
  search: '',
  levelFilter: 'all',     // 'all' | 'info' | 'warn' | 'error'
  events: [],
  eventsExhausted: false,
  proposalLabels: {},     // id → { client_name, project_code }
};

let _onOpenProposal = null;
let _onBackToWizard = null;

export function mountHistory({ container, onOpenProposal, onBack }) {
  _onOpenProposal = onOpenProposal;
  _onBackToWizard = onBack;

  container.innerHTML = `
    <div class="hist-tabs">
      <button class="hist-tab active" data-tab="proposals" type="button">Proposals</button>
      <button class="hist-tab" data-tab="activity" type="button">Activity</button>
    </div>
    <div class="hist-body" id="histBody"></div>
  `;

  container.querySelectorAll('.hist-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      container.querySelectorAll('.hist-tab').forEach(b => b.classList.toggle('active', b === btn));
      render();
    });
  });

  render();
}

export function refreshHistory() { render(); }

async function render() {
  const body = document.getElementById('histBody');
  if (!body) return;
  if (state.tab === 'proposals') await renderProposals(body);
  else await renderActivity(body);
}

// ── Proposals tab ──────────────────────────────────────────────────────

async function renderProposals(body) {
  body.innerHTML = `
    <div class="hist-toolbar">
      <input type="text" id="histSearch" class="hist-search" placeholder="Search proposals..." value="${escAttr(state.search)}">
    </div>
    <div id="histProposalsList" class="hist-loading">Loading…</div>
  `;
  const searchEl = body.querySelector('#histSearch');
  searchEl.addEventListener('input', debounce(async (e) => {
    state.search = e.target.value;
    await drawProposalList();
  }, 200));
  // Keep cursor on the input across redraws
  searchEl.focus();
  await drawProposalList();
}

async function drawProposalList() {
  const list = document.getElementById('histProposalsList');
  if (!list) return;
  list.classList.add('hist-loading');
  list.textContent = 'Loading…';
  let rows = [];
  try { rows = await listProposals({ search: state.search }); }
  catch (err) {
    list.classList.remove('hist-loading');
    list.innerHTML = `<div class="hist-empty">Could not load proposals.</div>`;
    console.warn(err);
    return;
  }
  list.classList.remove('hist-loading');

  if (rows.length === 0) {
    list.innerHTML = `<div class="hist-empty">No proposals yet. Start by importing a BOM.</div>`;
    return;
  }

  list.innerHTML = `
    <div class="hist-table" role="table">
      <div class="hist-thead" role="row">
        <span>Created</span>
        <span>Client</span>
        <span>Project code</span>
        <span>Status</span>
        <span>Last action</span>
        <span></span>
      </div>
      ${rows.map(r => proposalRowHtml(r)).join('')}
    </div>
  `;

  // Wire row clicks
  list.querySelectorAll('.hist-row[data-id]').forEach(row => {
    row.addEventListener('click', async (e) => {
      if (e.target.closest('.hist-row-actions')) return; // action click handled separately
      const id = row.dataset.id;
      try {
        const full = await getProposal(id);
        restoreSnapshot(full.snapshot || {});
        _onOpenProposal?.(full);
        logEvent({ level: 'info', type: 'proposal.opened', message: 'Opened from history', context: { from: 'history' }, proposalId: id });
      } catch (err) {
        console.warn('open proposal failed', err);
      }
    });
  });

  // Wire row actions (kebab → delete)
  list.querySelectorAll('.hist-row-actions button').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm('Delete this proposal? Activity history will be preserved.')) return;
      try {
        await deleteProposal(id);
        await drawProposalList();
      } catch (err) { console.warn('delete failed', err); }
    });
  });
}

function proposalRowHtml(r) {
  const status = r.status === 'exported'
    ? `<span class="status-pill status-pill-exported">Exported</span>`
    : `<span class="status-pill status-pill-draft">Draft</span>`;
  const lastAction = r.status === 'exported' && r.last_exported_at
    ? relativeTime(r.last_exported_at)
    : relativeTime(r.updated_at);
  return `
    <div class="hist-row" role="row" data-id="${escAttr(r.id)}">
      <span class="hist-cell" title="${escAttr(fullTime(r.created_at))}">${relativeTime(r.created_at)}</span>
      <span class="hist-cell hist-cell-client">${escText(r.client_name || '—')}</span>
      <span class="hist-cell hist-cell-code">${escText(r.project_code || '—')}</span>
      <span class="hist-cell">${status}</span>
      <span class="hist-cell" title="${escAttr(fullTime(r.updated_at))}">${lastAction}</span>
      <span class="hist-cell hist-row-actions">
        <button class="row-kebab" type="button" data-id="${escAttr(r.id)}" title="Delete proposal" aria-label="Delete proposal">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>
        </button>
      </span>
    </div>
  `;
}

// ── Activity tab ────────────────────────────────────────────────────────

async function renderActivity(body) {
  body.innerHTML = `
    <div class="hist-toolbar hist-toolbar-chips">
      ${chipHtml('all', 'All')}
      ${chipHtml('info', 'Info')}
      ${chipHtml('warn', 'Warnings')}
      ${chipHtml('error', 'Errors')}
    </div>
    <div id="histActivityList" class="hist-loading">Loading…</div>
    <div id="histActivityMore" class="hist-more-wrap" style="display:none;">
      <button class="btn btn-ghost btn-sm" id="histLoadMore" type="button">Load more</button>
    </div>
  `;
  body.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.levelFilter = btn.dataset.level;
      body.querySelectorAll('.filter-chip').forEach(b => b.classList.toggle('active', b === btn));
      state.events = [];
      state.eventsExhausted = false;
      await loadActivity({ replace: true });
    });
  });
  body.querySelector('#histLoadMore').addEventListener('click', () => loadActivity({ replace: false }));
  state.events = [];
  state.eventsExhausted = false;
  await loadActivity({ replace: true });
}

function chipHtml(level, label) {
  const active = state.levelFilter === level ? ' active' : '';
  return `<button class="filter-chip${active}" data-level="${level}" type="button">${label}</button>`;
}

async function loadActivity({ replace }) {
  const list = document.getElementById('histActivityList');
  const moreWrap = document.getElementById('histActivityMore');
  if (!list) return;
  if (replace) list.textContent = 'Loading…';

  let rows = [];
  const before = replace ? null : (state.events.at(-1)?.created_at ?? null);
  try {
    rows = await listEvents({ level: state.levelFilter, limit: PAGE_SIZE, before });
  } catch (err) {
    list.classList.remove('hist-loading');
    list.innerHTML = `<div class="hist-empty">Could not load activity.</div>`;
    console.warn(err);
    return;
  }

  if (replace) state.events = rows;
  else state.events.push(...rows);

  state.eventsExhausted = rows.length < PAGE_SIZE;

  // Resolve proposal labels for any rows that reference a proposal
  const ids = state.events.map(e => e.proposal_id).filter(Boolean);
  const labels = await fetchProposalLabels(ids);
  Object.assign(state.proposalLabels, labels);

  list.classList.remove('hist-loading');
  if (state.events.length === 0) {
    list.innerHTML = `<div class="hist-empty">No activity yet.</div>`;
    moreWrap.style.display = 'none';
    return;
  }

  list.innerHTML = `
    <div class="hist-table hist-table-activity" role="table">
      <div class="hist-thead" role="row">
        <span>Time</span>
        <span>Level</span>
        <span>Type</span>
        <span>Message</span>
        <span>Proposal</span>
      </div>
      ${state.events.map(eventRowHtml).join('')}
    </div>
  `;
  moreWrap.style.display = state.eventsExhausted ? 'none' : 'block';

  list.querySelectorAll('.activity-proposal[data-id]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.dataset.id;
      try {
        const full = await getProposal(id);
        restoreSnapshot(full.snapshot || {});
        _onOpenProposal?.(full);
        logEvent({ level: 'info', type: 'proposal.opened', message: 'Opened from activity', context: { from: 'activity' }, proposalId: id });
      } catch (err) { console.warn('open from activity failed', err); }
    });
  });
}

function eventRowHtml(e) {
  const dotClass = e.level === 'error' ? 'dot-error' : e.level === 'warn' ? 'dot-warn' : 'dot-info';
  const label = state.proposalLabels[e.proposal_id];
  const proposalCell = e.proposal_id
    ? `<span class="activity-proposal" data-id="${escAttr(e.proposal_id)}">${escText(label?.client_name || label?.project_code || 'Proposal')}</span>`
    : '<span class="activity-proposal-empty">—</span>';
  return `
    <div class="hist-row" role="row">
      <span class="hist-cell" title="${escAttr(fullTime(e.created_at))}">${relativeTime(e.created_at)}</span>
      <span class="hist-cell"><span class="level-dot ${dotClass}"></span></span>
      <span class="hist-cell hist-cell-code">${escText(e.type)}</span>
      <span class="hist-cell">${escText(e.message)}</span>
      <span class="hist-cell">${proposalCell}</span>
    </div>
  `;
}

// ── Helpers ────────────────────────────────────────────────────────────

function relativeTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function fullTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString();
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function escText(s) { return String(s ?? '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
function escAttr(s) { return escText(s).replace(/"/g, '&quot;'); }
