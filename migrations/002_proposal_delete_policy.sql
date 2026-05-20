-- 002_proposal_delete_policy.sql
-- Adds the missing DELETE RLS policy on proposals.
-- Without this, RLS silently allowed DELETE statements but matched 0 rows —
-- the client thought delete succeeded while the row stayed.
--
-- Run in the Supabase SQL editor after 001_init.sql.

create policy "Users delete own proposals" on proposals
  for delete using (auth.uid() = user_id);
