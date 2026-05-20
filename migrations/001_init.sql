-- 001_init.sql
-- Initial schema for the Okos Proposal Generator.
-- Run in the Supabase SQL editor (or via `supabase db push` if using the local CLI).

-- Proposals table — one row per proposal, holds latest working state
create table proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'draft' check (status in ('draft', 'exported')),
  client_name text,
  project_code text,
  facility_name text,
  project_address text,
  date_field text,
  revision text,
  snapshot jsonb not null default '{}'::jsonb,
  last_exported_at timestamptz,
  last_exported_filename text
);

create index proposals_user_id_idx on proposals(user_id);
create index proposals_updated_at_idx on proposals(updated_at desc);
create index proposals_client_name_idx on proposals(client_name);

-- Events table — append-only audit log
create table events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  proposal_id uuid references proposals(id) on delete set null,
  level text not null check (level in ('info', 'warn', 'error')),
  type text not null,
  message text not null,
  context jsonb not null default '{}'::jsonb
);

create index events_user_id_idx on events(user_id);
create index events_created_at_idx on events(created_at desc);
create index events_level_idx on events(level);
create index events_proposal_id_idx on events(proposal_id);

-- Auto-update updated_at on proposals
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger proposals_updated_at
  before update on proposals
  for each row execute function update_updated_at();

-- RLS — users only see their own data
alter table proposals enable row level security;
alter table events enable row level security;

create policy "Users read own proposals" on proposals for select using (auth.uid() = user_id);
create policy "Users insert own proposals" on proposals for insert with check (auth.uid() = user_id);
create policy "Users update own proposals" on proposals for update using (auth.uid() = user_id);

-- Events are append-only: insert + select only, no update/delete
create policy "Users read own events" on events for select using (auth.uid() = user_id);
create policy "Users insert own events" on events for insert with check (auth.uid() = user_id);
