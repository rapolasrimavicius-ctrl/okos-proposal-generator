// supabase/functions/gemini-proxy/index.ts
// Forwards generateContent requests to the Gemini API using a server-held key.
// Verifies the caller's Supabase JWT first. Never exposes the API key to the client.
//
// Deploy: `supabase functions deploy gemini-proxy`
// Required secrets:
//   GEMINI_API_KEY   — set via `supabase secrets set GEMINI_API_KEY=AIza...`
//   ALLOWED_ORIGIN   — set via `supabase secrets set ALLOWED_ORIGIN=https://your.app`
//                       (defaults to "*" when unset — fine for dev, tighten for prod)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_MODELS = new Set(["gemini-2.5-flash", "gemini-2.5-pro"]);

const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    // ── Auth: verify Supabase JWT ──
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!jwt) return json({ error: "unauthorized" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: userData, error: userErr } = await supabase.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);

    // ── Config: Gemini key ──
    const apiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
    if (!apiKey) return json({ error: "server_misconfigured" }, 500);

    // ── Body validation ──
    const body = await req.json().catch(() => null) as
      | { model?: string; contents?: unknown; generationConfig?: unknown; systemInstruction?: unknown }
      | null;
    if (!body || typeof body !== "object") return json({ error: "bad_request" }, 400);

    const model = String(body.model ?? "");
    if (!ALLOWED_MODELS.has(model)) return json({ error: "model_not_allowed" }, 400);
    if (!Array.isArray(body.contents) || body.contents.length === 0) {
      return json({ error: "bad_request", detail: "contents required" }, 400);
    }

    const forward: Record<string, unknown> = { contents: body.contents };
    if (body.generationConfig) forward.generationConfig = body.generationConfig;
    if (body.systemInstruction) forward.systemInstruction = body.systemInstruction;

    // ── Forward to Gemini ──
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(forward),
      },
    );

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  } catch (err) {
    console.error("gemini-proxy error:", err);
    return json({ error: "proxy_failed" }, 500);
  }
});
