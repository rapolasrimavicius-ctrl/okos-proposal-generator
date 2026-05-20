// logger.js — thin wrapper around Supabase events insert.
// Logging failures must never block the user. We swallow errors and console.warn.

import { getSupabase, getCurrentUser } from './db.js';

/**
 * @param {object} opts
 * @param {'info'|'warn'|'error'} opts.level
 * @param {string} opts.type        — dot-separated event type, e.g. 'bom.imported'
 * @param {string} opts.message
 * @param {object} [opts.context]   — JSON-serializable
 * @param {string|null} [opts.proposalId]
 */
export async function logEvent({ level, type, message, context = {}, proposalId = null }) {
  try {
    const user = getCurrentUser();
    if (!user) return; // not signed in — nothing to log against
    const supabase = getSupabase();
    if (!supabase) return;

    const { error } = await supabase.from('events').insert({
      user_id: user.id,
      proposal_id: proposalId,
      level,
      type,
      message,
      context,
    });
    if (error) console.warn('logEvent insert failed:', error.message);
  } catch (err) {
    console.warn('logEvent threw:', err);
  }
}
