# Okos Proposal Generator

Static single-page app that imports a BOM Excel file, fills out a 4-step wizard, and exports a DOCX technical proposal.

Now backed by Supabase for:
- Magic-link auth (single user, per-account)
- Per-user proposal history (latest working state)
- Append-only audit log (BOM imports, AI runs, exports, errors)
- Server-side Gemini proxy (the API key never lives in the browser)

The UI follows Vercel's monochrome design language. The DOCX output still uses the Okos brand (navy / teal / Calibri).

---

## File map

| Path | Purpose |
|------|---------|
| `index.html` | Single-page app. Wizard markup + existing wizard JS (inline `<script>`). Loads the module layer via `app.js`. |
| `app.js` | ES module orchestrator. Initializes auth, mounts history view, exposes `window.Okos` for the inline wizard. |
| `auth.js` | Magic-link login overlay, header signed-in indicator, sign-out, session listener. |
| `db.js` | Supabase client + proposal/event CRUD + snapshot serializer / restorer. |
| `gemini.js` | Client wrapper that POSTs to the Supabase `gemini-proxy` Edge Function with the user's JWT. |
| `history.js` | History view (Proposals + Activity tabs with search, filters, pagination). |
| `logger.js` | `logEvent({ level, type, message, context, proposalId })` → inserts into `events`. |
| `config.example.js` | Template for forks. Copy to `config.js` and fill in your project values. |
| `config.js` | Exports `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The publishable (anon) key is safe to commit — RLS protects the data. |
| `migrations/001_init.sql` | Schema: `proposals`, `events`, RLS policies, `updated_at` trigger. |
| `supabase/functions/gemini-proxy/index.ts` | Deno Edge Function — verifies the caller's JWT and forwards `generateContent` calls to Gemini using the server-held API key. |
| `.gitignore` | `config.js`, OS noise, Supabase CLI state. |

---

## Setup from a fresh clone

You'll need:
- A Supabase project (free tier is fine)
- A Gemini API key (Google AI Studio — free tier is fine)
- The Supabase CLI installed locally for deploying the Edge Function: https://supabase.com/docs/guides/cli

### 1. Create the Supabase project

1. Go to https://supabase.com → New project.
2. Region: **Canada (ca-central-1)**.
3. Wait for the project to provision.
4. Note the project URL and anon key (Settings → API).

### 2. Run the SQL migration

Open the SQL editor in your Supabase project → paste the contents of `migrations/001_init.sql` → Run.

This creates the `proposals` and `events` tables, the `updated_at` trigger, and the RLS policies that keep every user's data isolated.

### 3. Create `config.js`

```bash
cp config.example.js config.js
```

Edit `config.js` and paste in the project URL and **publishable (anon) key** from step 1.

You can commit this file — Supabase's publishable key is designed to be public, and Row Level Security gates what each user can read/write. Just be sure you're pasting the publishable key (`sb_publishable_...` or the legacy `anon` JWT), **never** the secret/service-role key.

### 4. Configure Supabase Auth redirects

In your Supabase project: **Authentication → URL Configuration**.

- **Site URL:** the host where the tool is deployed (e.g. `https://tools.okos.ca`). For local dev: `http://localhost:8080` (or wherever you serve it).
- **Redirect URLs:** add the same URL to the allowlist.

Magic-link emails will direct users back to this URL with a session token in the URL fragment, which the Supabase client picks up automatically.

### 5. Deploy the Gemini proxy Edge Function

From the project root:

```bash
# One-time: link the CLI to your project
supabase link --project-ref YOUR_PROJECT_REF

# Set secrets (the proxy reads GEMINI_API_KEY at runtime)
supabase secrets set GEMINI_API_KEY=AIza...
supabase secrets set ALLOWED_ORIGIN=https://tools.okos.ca   # or http://localhost:8080 for dev

# Deploy. JWT verification is on by default; the function code re-verifies anyway.
supabase functions deploy gemini-proxy
```

The function lives at: `https://YOUR_PROJECT.supabase.co/functions/v1/gemini-proxy`.

The Gemini API key is **only** stored as a Supabase Function secret — never in the repo, browser, or any database table.

### 6. Serve the app

It's a static site. Any HTTP server works:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Open the URL you configured in step 4, sign in with the magic link, and you're set.

---

## How it works

### Auth gate

On page load, `app.js` initializes the Supabase client and checks for a session.
- No session → renders the login overlay; everything else is hidden.
- Session present → reveals the wizard, populates the header with `email · Sign out`.
- `supabase.auth.onAuthStateChange` swaps the view live when the user signs in/out — no page reload needed.

### Auto-save

A proposal row is created lazily — on the **first** successful BOM import or the first edit on Review & Edit. Subsequent edits debounce 800ms and update the same row's `snapshot` (a JSONB column).

Status starts as `draft`. After the first successful DOCX download it flips to `exported` (continued edits keep the `exported` status; each export inserts a new event into the audit log, which is how historical state is recoverable).

Drawings (image / PDF binaries) are **not** stored in Supabase. Only metadata (names + MIME types) is persisted in the snapshot. Re-opening a past proposal restores everything except the drawings; the user re-uploads if they want to re-export.

### Audit log

Every interesting action inserts a row into `events`. Logging is best-effort — a failed insert console-warns and never blocks the user.

| Trigger | Level | Type |
|---|---|---|
| Proposal row created | info | `proposal.created` |
| BOM Excel parsed | info | `bom.imported` |
| Auto-generate succeeded | info | `ai.generated` |
| DOCX downloaded | info | `proposal.exported` |
| Past proposal opened | info | `proposal.opened` |
| Gemini proxy returns non-2xx | error | `error.gemini` |
| BOM parse throws | error | `error.bom_parse` |
| DOCX build throws | error | `error.docx_export` |
| Supabase write fails | warn | `warn.persistence` |

There is no "Clear history" action anywhere. The events table has no UPDATE or DELETE RLS policy.

### Gemini proxy

The client never sees the Gemini API key. `gemini.js` POSTs to `${SUPABASE_URL}/functions/v1/gemini-proxy` with `Authorization: Bearer <jwt>`. The Edge Function:

1. Verifies the JWT against Supabase auth.
2. Reads `GEMINI_API_KEY` from its secrets (never returned to the client).
3. Validates the model against an allowlist (`gemini-2.5-flash`, `gemini-2.5-pro`).
4. Forwards the validated body to `generativelanguage.googleapis.com/...:generateContent`.
5. Passes through the upstream status code and JSON body so the client can see 429s/5xxs/etc.

To rotate the Gemini key:

```bash
supabase secrets set GEMINI_API_KEY=AIza_new_key
# No redeploy required — secrets are read at runtime.
```

To allow a new model, edit the `ALLOWED_MODELS` set at the top of `supabase/functions/gemini-proxy/index.ts` and redeploy.

### History UI

Top-right header link "History" toggles the wizard view with a History view:

- **Proposals tab** — searchable list (client name + project code) with status pills, relative timestamps, kebab-menu delete with confirm. Clicking a row restores the snapshot and jumps to Review & Edit.
- **Activity tab** — append-only event log with filter chips (All / Info / Warnings / Errors), 50-row pages, "Load more" at the bottom. Proposal references are clickable if the proposal still exists.

---

## Style discipline

- Don't add new colors. Reuse `--success`, `--error`, `--warning` if applicable, or stay monochrome with 1px borders.
- Geist Sans for UI; Geist Mono for technical IDs (project codes, event types, audit values).
- No box shadows, gradients, animations longer than 150ms, or filled status backgrounds.
- The DOCX output is a brand artifact — leave its Calibri + navy/teal styling alone.

---

## Manual setup checklist (cheat sheet)

- [ ] Supabase project created in `ca-central-1`
- [ ] `migrations/001_init.sql` run in the SQL editor
- [ ] `config.js` created from `config.example.js` with project URL + anon key
- [ ] Auth → URL Configuration: Site URL + redirect URL set
- [ ] `supabase secrets set GEMINI_API_KEY=...`
- [ ] `supabase secrets set ALLOWED_ORIGIN=...`
- [ ] `supabase functions deploy gemini-proxy`
- [ ] Static server pointed at the project root, accessible at the configured Site URL
