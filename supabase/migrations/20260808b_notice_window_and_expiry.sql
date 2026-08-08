-- The one-hour window was too tight, and it failed silently in the one case it
-- was most likely to meet: the sweep not running.
--
-- Ken's notice sat 'due' for 22 minutes because its trigger had never been
-- installed. Had that gone unnoticed for another 38 it would have aged out and
-- been dropped — no email, no error, and the row still reading 'due' for ever,
-- which claims it is still owed when it never will be.
--
-- The real guard was always read_by_employer_at: if the employer has since seen
-- the reply in the workspace, saying "you have a reply" is worse than silence.
-- That check does the meaningful work and is unaffected by how long a delivery
-- takes. The time window only exists to stop a long outage emptying a week of
-- backlog into somebody's inbox at once, and a day is plenty for that.
--
-- Anything genuinely too old is now marked 'expired' rather than left 'due', so
-- the queue tells the truth about what it still owes.

create or replace function public.workspace_notices_due()
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare v_out jsonb;
begin
  -- Retire the genuinely stale first, so they stop being counted as owed.
  update employer_workspace_messages
     set notice_state = 'expired', notice_at = now()
   where notice_state = 'due'
     and created_at <= now() - interval '24 hours';

  select coalesce(jsonb_agg(jsonb_build_object(
           'message_id',    m.id,
           'employer_name', coalesce(e.dba, e.legal_name),
           'agent_name',    m.sender_name,
           'recipients',    coalesce((
              select jsonb_agg(jsonb_build_object('name', c.name, 'email', c.email))
                from employer_workspace_members wm
                join contacts c on c.id = wm.contact_id
               where wm.employer_id = e.id
                 and wm.status = 'active'
                 and coalesce(c.email,'') <> ''), '[]'::jsonb))), '[]'::jsonb)
    into v_out
    from employer_workspace_messages m
    join employers e on e.id = m.employer_id
   where m.notice_state = 'due'
     and m.sender_kind = 'agent'
     and m.read_by_employer_at is null;   -- they beat us to it; say nothing

  return v_out;
end $$;

alter table employer_workspace_messages
  drop constraint if exists employer_workspace_messages_notice_state_check;
alter table employer_workspace_messages
  add constraint employer_workspace_messages_notice_state_check
  check (notice_state in ('none','due','sent','failed','expired'));

revoke all on function public.workspace_notices_due() from public;
revoke execute on function public.workspace_notices_due() from anon;
revoke execute on function public.workspace_notices_due() from authenticated;
grant execute on function public.workspace_notices_due() to service_role;
