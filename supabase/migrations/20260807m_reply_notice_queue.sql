-- The notice never arrived, and the reason is a design fault rather than a typo.
--
-- I had the BROWSER send it: agent_reply returned notify:true and crm.js then
-- called Apps Script. That makes delivery depend on the agent's tab being on the
-- current build, still open, and online. Ken's tab was almost certainly running a
-- cached crm.js from before the change — the old code checked `data !== true`
-- against what is now jsonb, decided the send had failed, and never made the
-- call. His own next message was "Resending a message. Did it go out to email?",
-- which is exactly what that looks like from the outside.
--
-- Even with a fresh tab it was fragile: close the browser too quickly, lose wifi
-- for a second, and the notice is gone with nothing recording that it was owed.
--
-- So the INTENT is now recorded in the database and a job delivers it. The state
-- lives on the message itself, which means an unsent notice is visible, provable,
-- and retried rather than lost. Nothing depends on a browser staying open.
-- The sweep rides the existing five-minute processAllAgentInboxes trigger, so no
-- new trigger has to be installed by hand from the Apps Script editor.
--
-- GRANTS: the two queue functions are for the scheduled job ONLY. Not anon, and
-- not authenticated either — no signed-in user has any reason to drain a mail
-- queue, and this is the one place in this feature that runs with the service
-- key. Revoked by name from both; see 20260807i for why "from public" is not
-- enough on this schema. Verified: anon false, authenticated false,
-- service_role true on both.

alter table employer_workspace_messages
  add column if not exists notice_state text not null default 'none'
      check (notice_state in ('none','due','sent','failed')),
  add column if not exists notice_at timestamptz;

create index if not exists ewm_notice_due_idx
  on employer_workspace_messages (created_at)
  where notice_state = 'due';

comment on column employer_workspace_messages.notice_state is
  'none = no email owed. due = owed, awaiting the sweep. sent/failed = outcome.';


-- agent_reply now RECORDS the decision instead of handing it to the browser.
drop function if exists public.agent_reply(text, uuid, text);

create or replace function public.agent_reply(p_kind text, p_thread uuid, p_body text)
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare
  v_agent       agents%rowtype;
  v_pending     boolean;
  v_last_client timestamptz;
  v_notify      boolean;
  v_id          uuid;
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
      (employer_id, sender_kind, sender_agent_id, sender_name, body, notice_state)
    values (p_thread, 'agent', v_agent.id,
            coalesce(v_agent.display_name, v_agent.name), left(p_body, 5000),
            case when v_notify then 'due' else 'none' end)
    returning id into v_id;

    return jsonb_build_object('ok', true, 'notify', v_notify, 'message_id', v_id);
  end if;

  raise exception 'unknown conversation kind: %', p_kind;
end $$;

revoke all on function public.agent_reply(text, uuid, text) from public;
revoke execute on function public.agent_reply(text, uuid, text) from anon;
grant execute on function public.agent_reply(text, uuid, text) to authenticated;
grant execute on function public.agent_reply(text, uuid, text) to service_role;


-- What the sweep picks up. Everything it needs in one call, so the job makes one
-- request rather than five per message.
-- A notice still 'due' after an hour is stale — by then the employer has almost
-- certainly seen it in the workspace, and an email saying "you have a reply" for
-- something already read is worse than no email. read_by_employer_at is checked
-- for the same reason: they beat us to it, so say nothing.
create or replace function public.workspace_notices_due()
returns jsonb language sql stable security definer set search_path to 'public'
as $$
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
    from employer_workspace_messages m
    join employers e on e.id = m.employer_id
   where m.notice_state = 'due'
     and m.sender_kind = 'agent'
     and m.read_by_employer_at is null
     and m.created_at > now() - interval '1 hour';
$$;

revoke all on function public.workspace_notices_due() from public;
revoke execute on function public.workspace_notices_due() from anon;
revoke execute on function public.workspace_notices_due() from authenticated;
grant execute on function public.workspace_notices_due() to service_role;


create or replace function public.workspace_notice_done(p_message uuid, p_ok boolean)
returns void language sql security definer set search_path to 'public'
as $$
  update employer_workspace_messages
     set notice_state = case when p_ok then 'sent' else 'failed' end,
         notice_at = now()
   where id = p_message and notice_state = 'due';
$$;

revoke all on function public.workspace_notice_done(uuid, boolean) from public;
revoke execute on function public.workspace_notice_done(uuid, boolean) from anon;
revoke execute on function public.workspace_notice_done(uuid, boolean) from authenticated;
grant execute on function public.workspace_notice_done(uuid, boolean) to service_role;


-- The ones Ken never received. Both genuinely qualified, but the older has since
-- been read, so only the unread one is owed — which is the rule the sweep applies
-- anyway. Queue it so the fix proves itself rather than being asserted.
update employer_workspace_messages
   set notice_state = 'due'
 where sender_kind = 'agent'
   and read_by_employer_at is null
   and notice_state = 'none'
   and created_at > now() - interval '1 hour';
