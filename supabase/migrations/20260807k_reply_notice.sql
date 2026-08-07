-- Ken: if an agent does not answer within five minutes, email the client when
-- the reply finally lands. Somebody who asked a question an hour ago is not
-- sitting watching the screen, and an unread reply helps nobody.
--
-- WHO DECIDES. agent_reply decides, because only it sees the state before the
-- new message exists. Two conditions, both necessary:
--
--   1. No agent message is already sitting unread by the employer. If we have
--      told them once and they have not looked, a second email adds nothing —
--      and without this, an agent typing three replies in a row sends three
--      emails. It re-arms itself the moment they read.
--   2. Their most recent message is older than five minutes. Answer faster than
--      that and they are almost certainly still there watching.
--
--   An agent opening a conversation cold has no client message to measure from.
--   That notifies: an unprompted message nobody ever sees is the worst case, not
--   an exception to skip.
--
-- WHO IS TOLD. workspace_notice_recipients enforces the seat check with the
-- CALLER's identity. Apps Script sends the agent's own token as BOTH apikey and
-- Authorization, so no service key is in that request at all and the role cannot
-- be anything but theirs. No address is ever supplied by the caller — it is
-- keyed on the employer id and the recipients come back from here.
--
-- RETURN TYPE CHANGED: agent_reply was boolean and is now jsonb {ok, notify}.
-- crm.js checked `data !== true`, which would have reported every successful
-- reply as a failure — fixed in the same commit. There is exactly one caller.
--
-- GRANTS: the return-type change needs a DROP, which re-grants EXECUTE to anon
-- through Supabase's default privileges every time. See 20260807i. Both
-- functions revoke anon BY NAME below; probed after applying, both 42501.

drop function if exists public.agent_reply(text, uuid, text);

create or replace function public.agent_reply(p_kind text, p_thread uuid, p_body text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare
  v_agent       agents%rowtype;
  v_pending     boolean;
  v_last_client timestamptz;
  v_notify      boolean;
begin
  if not is_an_agent() then raise exception 'agents only'; end if;
  if coalesce(btrim(p_body),'') = '' then
    return jsonb_build_object('ok', false, 'notify', false);
  end if;

  select * into v_agent from agents where lower(email) = lower(auth.jwt() ->> 'email');

  if p_kind = 'employer' then
    if not exists (select 1 from employers e
                    where e.id = p_thread and can_see_agent_work(e.primary_agent_id))
    then raise exception 'not your conversation'; end if;

    -- Both measured BEFORE the insert, or the message we are about to write
    -- would count as the unread one and suppress its own notice.
    v_pending := exists (select 1 from employer_workspace_messages m
                          where m.employer_id = p_thread
                            and m.sender_kind = 'agent'
                            and m.read_by_employer_at is null);

    select max(m.created_at) into v_last_client
      from employer_workspace_messages m
     where m.employer_id = p_thread and m.sender_kind = 'employer';

    v_notify := (not v_pending)
            and (v_last_client is null
                 or now() - v_last_client > interval '5 minutes');

    insert into employer_workspace_messages
      (employer_id, sender_kind, sender_agent_id, sender_name, body)
    values (p_thread, 'agent', v_agent.id,
            coalesce(v_agent.display_name, v_agent.name), left(p_body, 5000));

    return jsonb_build_object('ok', true, 'notify', v_notify);
  end if;

  raise exception 'unknown conversation kind: %', p_kind;
end $$;

revoke all on function public.agent_reply(text, uuid, text) from public;
revoke execute on function public.agent_reply(text, uuid, text) from anon;
grant execute on function public.agent_reply(text, uuid, text) to authenticated;
grant execute on function public.agent_reply(text, uuid, text) to service_role;


create or replace function public.workspace_notice_recipients(p_employer uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare v_out jsonb;
begin
  if not is_an_agent() then raise exception 'agents only'; end if;
  if not exists (select 1 from employers e
                  where e.id = p_employer and can_see_agent_work(e.primary_agent_id))
  then raise exception 'not your conversation'; end if;

  select jsonb_build_object(
           'employer_name', coalesce(e.dba, e.legal_name),
           -- The agent who REPLIED, not whoever owns the record. The client is
           -- being told who answered them.
           'agent_name', (select coalesce(a.display_name, a.name) from agents a
                           where lower(a.email) = lower(auth.jwt() ->> 'email')),
           'recipients', coalesce((
              select jsonb_agg(jsonb_build_object('name', c.name, 'email', c.email))
                from employer_workspace_members m
                join contacts c on c.id = m.contact_id
               where m.employer_id = e.id
                 and m.status = 'active'
                 and coalesce(c.email,'') <> ''), '[]'::jsonb))
    into v_out
    from employers e
   where e.id = p_employer;

  return coalesce(v_out, '{}'::jsonb);
end $$;

revoke all on function public.workspace_notice_recipients(uuid) from public;
revoke execute on function public.workspace_notice_recipients(uuid) from anon;
grant execute on function public.workspace_notice_recipients(uuid) to authenticated;
grant execute on function public.workspace_notice_recipients(uuid) to service_role;
