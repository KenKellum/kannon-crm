-- "UPDATE is not allowed in a non-volatile function".
--
-- carrier_thread was declared STABLE because it mostly reads — but it also marks
-- the agent's messages as read on the way out, and Postgres refuses a write in a
-- STABLE function. So opening the drawer failed on the very first attempt, every
-- time.
--
-- Dropping the read-marking would have been the wrong fix: without it the unread
-- badge never clears and the rep is nagged about messages they have already read.
-- Volatile is simply the truth about what this function does.
--
-- Swept the schema for the same mistake — any STABLE or IMMUTABLE function whose
-- body contains an UPDATE, INSERT or DELETE:
--
--   select p.proname from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.provolatile in ('s','i')
--      and p.prosrc ~* '(^|[^a-z_])(update|insert into|delete from)([^a-z_]|$)';
--
-- carrier_thread was the only one.
--
-- VERIFIED as Matt, rolled back, walking his exact path: sign the agreement,
-- open the thread, send a message, re-open — one message present.

create or replace function public.carrier_thread(p_submission uuid)
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare v_out jsonb;
begin
  if not exists (select 1 from marketing_submissions s
                  where s.id = p_submission
                    and s.contact_id in (select id from my_carrier_contacts()))
  then raise exception 'not your request'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'body', m.body, 'who', m.sender_name,
           'mine', m.sender_kind = 'carrier', 'at', m.created_at)
         order by m.created_at), '[]'::jsonb)
    into v_out
    from carrier_workspace_messages m
   where m.submission_id = p_submission;

  -- Read on the way out, which is what makes the badge mean something.
  update carrier_workspace_messages
     set read_by_carrier_at = now()
   where submission_id = p_submission and sender_kind = 'agent'
     and read_by_carrier_at is null;

  return v_out;
end $$;

revoke all on function public.carrier_thread(uuid) from public;
revoke execute on function public.carrier_thread(uuid) from anon;
grant execute on function public.carrier_thread(uuid) to authenticated;
