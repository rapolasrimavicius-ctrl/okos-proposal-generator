// gemini.js — client-side wrapper for the Supabase Edge Function `gemini-proxy`.
// The Gemini API key never leaves the server; the client only forwards a Supabase JWT.

import { SUPABASE_URL } from './config.js';
import { getCurrentSession } from './db.js';

const PROXY_URL = `${SUPABASE_URL}/functions/v1/gemini-proxy`;

/**
 * Call the proxy with a Gemini-compatible body.
 * @param {object} opts
 * @param {string} opts.model
 * @param {Array}  opts.contents
 * @param {object} [opts.generationConfig]
 * @param {object} [opts.systemInstruction]
 * @returns {Promise<{ status: number, data: any, ok: boolean }>}
 */
export async function generate({ model, contents, generationConfig, systemInstruction }) {
  const session = getCurrentSession();
  if (!session?.access_token) {
    return { status: 401, ok: false, data: { error: { message: 'Not signed in.' } } };
  }

  const res = await fetch(PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ model, contents, generationConfig, systemInstruction }),
  });

  let data;
  try { data = await res.json(); }
  catch { data = { error: { message: `Bad response from proxy (HTTP ${res.status})` } }; }

  return { status: res.status, ok: res.ok, data };
}
