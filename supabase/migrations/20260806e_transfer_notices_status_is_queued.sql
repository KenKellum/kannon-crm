-- The queue said 'pending'; every consumer said 'queued'.
--
-- Caught in a dress rehearsal before the sending job went live. terminate_agent
-- inserts without naming a status, so rows took the column default 'pending',
-- while runAgentTransferIntroductions() in Code.gs filters status=eq.queued.
-- The job would have found nothing, for ever, and logged a clean success doing
-- it -- an empty queue and a broken filter look identical in a log, which is
-- what makes this kind of mismatch worth catching before it ships rather than
-- after somebody notices no client ever got an introduction.
--
-- Root cause worth remembering: the table was created by the first termination
-- migration, and the migration FILE written afterwards was reconstructed from
-- intent rather than from the applied schema. The file said uuid ids and
-- 'queued'; the database had bigserial ids and 'pending'. `create table if not
-- exists` then made the mismatch invisible -- re-running the file changes
-- nothing and reports success. 20260806c has been corrected to match reality.
--
-- 'queued' wins over 'pending': it is what the sending job, the partial index
-- and the written handover all use, and it describes what the row IS rather
-- than how it feels. The table was empty, so no data changed.
--
-- Applied to production 2026-08-06 as `transfer_notices_status_is_queued`.

alter table public.agent_transfer_notices
  alter column status set default 'queued';

update public.agent_transfer_notices set status = 'queued' where status = 'pending';

alter table public.agent_transfer_notices
  drop constraint if exists agent_transfer_notices_status_check;
alter table public.agent_transfer_notices
  add constraint agent_transfer_notices_status_check
  check (status in ('queued', 'sent', 'failed', 'skipped_opted_out', 'skipped_no_email'));
