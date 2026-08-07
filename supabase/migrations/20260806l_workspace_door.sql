-- Phase 5: the workspace's back of house, 2026-08-06.
--
-- THE DOCTRINE, decided in Phase 2 so that this phase adds a door rather than
-- retrofitting one: the employer's own people NEVER read employer tables
-- directly. Row security is row-level and cannot restrict columns, so a
-- table-level policy would silently publish any agent-only column somebody adds
-- later — notes, lead intel, margins. Everything the employer side can reach is
-- a named function returning a fixed shape.
--
-- Verified by role simulation: a live workspace member reading the tables
-- directly sees 0 rows on employers, employer_workspace_messages, contacts,
-- deals, employer_workspace_members and carriers. The function is the only way
-- in, which is exactly the intent.

create table if not exists public.employer_workspace_messages (
  id                  uuid primary key default gen_random_uuid(),
  employer_id         uuid not null references public.employers(id) on delete cascade,
  sender_kind         text not null check (sender_kind in ('agent','employer')),
  sender_agent_id     uuid references public.agents(id),
  sender_member_id    uuid references public.employer_workspace_members(id) on delete set null,
  sender_name         text,
  body                text not null check (length(btrim(body)) > 0),
  created_at          timestamptz not null default now(),
  read_by_agent_at    timestamptz,
  read_by_employer_at timestamptz
);
create index if not exists ewm_employer_idx
  on public.employer_workspace_messages (employer_id, created_at desc);

alter table public.employer_workspace_messages enable row level security;
revoke all on public.employer_workspace_messages from anon;
grant select, insert, update on public.employer_workspace_messages to authenticated;

drop policy if exists "agents manage workspace messages" on public.employer_workspace_messages;
create policy "agents manage workspace messages" on public.employer_workspace_messages
  for all to authenticated
  using      (is_an_agent() and exists (select 1 from public.employers e
                where e.id = employer_id and can_see_agent_work(e.primary_agent_id)))
  with check (is_an_agent() and exists (select 1 from public.employers e
                where e.id = employer_id and can_see_agent_work(e.primary_agent_id)));

-- ── the door ─────────────────────────────────────────────────────────────────
-- Volatile rather than stable because the first successful call is what
-- activates the invitation. Safe: reaching this function requires a live
-- session for that email address, which requires having opened the link sent to
-- it. A link forwarded to somebody else grants them nothing.
create or replace function public.get_my_workspace()
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_email text; v_m record; v_agent record;
  v_tasks jsonb := '[]'::jsonb; v_msgs jsonb := '[]'::jsonb;
  v_baa record; v_census record;
begin
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then return null; end if;

  select m.id, m.employer_id, m.role, m.status, e.legal_name, e.dba, e.primary_agent_id
    into v_m
    from employer_workspace_members m
    join employers e on e.id = m.employer_id
   where lower(m.email) = v_email
     and m.status in ('invited','active')   -- 'revoked' is excluded here
   order by m.invited_at desc
   limit 1;
  if not found then return null; end if;

  if v_m.status = 'invited' then
    update employer_workspace_members
       set status = 'active', activated_at = now()
     where id = v_m.id;
  end if;

  select display_name, name, email, phone into v_agent
    from agents where id = v_m.primary_agent_id;

  select id, status into v_baa from baa_records
   where deal_id in (select id from deals where employer_id = v_m.employer_id)
   order by created_at desc limit 1;
  if v_baa.id is not null then
    v_tasks := v_tasks || jsonb_build_object(
      'kind','baa','status',v_baa.status,'id',v_baa.id,
      'label', case when v_baa.status = 'signed'
                    then 'HIPAA agreement — signed'
                    else 'Sign the HIPAA agreement' end);
  end if;

  select id, status into v_census from census_requests
   where deal_id in (select id from deals where employer_id = v_m.employer_id)
   order by created_at desc limit 1;
  if v_census.id is not null then
    v_tasks := v_tasks || jsonb_build_object(
      'kind','census','status',v_census.status,'id',v_census.id,
      'label', case when v_census.status = 'submitted'
                    then 'Employee census — received, thank you'
                    else 'Complete your employee census' end);
  end if;

  select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb) into v_msgs
    from (select jsonb_build_object(
            'id', id, 'mine', sender_kind = 'employer',
            'who', sender_name, 'body', body,
            'created_at', created_at) as x
          from employer_workspace_messages
          where employer_id = v_m.employer_id
          order by created_at desc limit 50) s;

  update employer_workspace_messages
     set read_by_employer_at = now()
   where employer_id = v_m.employer_id
     and sender_kind = 'agent' and read_by_employer_at is null;

  return jsonb_build_object(
    'employer', jsonb_build_object('id', v_m.employer_id, 'name', v_m.legal_name, 'dba', v_m.dba),
    'role',     v_m.role,
    'agent',    jsonb_build_object('name', coalesce(v_agent.display_name, v_agent.name),
                                   'email', v_agent.email, 'phone', v_agent.phone),
    'tasks',    v_tasks,
    'messages', v_msgs);
end $$;

revoke all on function public.get_my_workspace() from public, anon;
grant execute on function public.get_my_workspace() to authenticated;

-- They may only ever write as themselves, to their own employer. Both are taken
-- from the session, never from anything the page sends.
create or replace function public.workspace_send_message(p_body text)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare v_email text; v_m record; v_who text;
begin
  if coalesce(btrim(p_body),'') = '' then return false; end if;
  v_email := lower(coalesce(auth.jwt() ->> 'email', ''));
  if v_email = '' then return false; end if;

  select m.id, m.employer_id, m.contact_id, e.legal_name, e.primary_agent_id
    into v_m
    from employer_workspace_members m
    join employers e on e.id = m.employer_id
   where lower(m.email) = v_email and m.status = 'active'
   order by m.invited_at desc limit 1;
  if not found then return false; end if;

  select coalesce(name, v_email) into v_who from contacts where id = v_m.contact_id;

  insert into employer_workspace_messages
    (employer_id, sender_kind, sender_member_id, sender_name, body)
  values (v_m.employer_id, 'employer', v_m.id, coalesce(v_who, v_email), left(p_body, 5000));

  -- Left UNREAD on purpose: an unanswered message in a portal is worse than no
  -- portal, so this has to reach the agent's Needs Attention list.
  insert into activities (contact_id, agent_id, activity_type, subject, body_snippet, metadata, source)
  values (v_m.contact_id, v_m.primary_agent_id, 'workspace_message',
          'Message from ' || v_m.legal_name, left(p_body, 200),
          jsonb_build_object('employer_id', v_m.employer_id), 'workspace');
  return true;
end $$;

revoke all on function public.workspace_send_message(text) from public, anon;
grant execute on function public.workspace_send_message(text) to authenticated;

-- ── the agent side of the invitation ─────────────────────────────────────────
-- Access is this explicit row and nothing else: never an email domain, never a
-- name match. Sending the link is Apps Script's job.
create or replace function public.workspace_invite_member(
  p_employer_id uuid, p_contact_id uuid, p_role text)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare v_email text; v_agent uuid; v_id uuid;
begin
  if not is_an_agent() then raise exception 'agents only'; end if;
  if not exists (select 1 from employers e
                  where e.id = p_employer_id and can_see_agent_work(e.primary_agent_id))
  then raise exception 'not your employer'; end if;

  select email into v_email from contacts where id = p_contact_id;
  if coalesce(v_email,'') = '' then raise exception 'that contact has no email address'; end if;

  select id into v_agent from agents where lower(email) = lower(auth.jwt() ->> 'email');

  insert into employer_workspace_members (employer_id, contact_id, email, role, invited_by_agent_id)
  values (p_employer_id, p_contact_id, lower(v_email), p_role, v_agent)
  on conflict (employer_id, lower(email)) do update
    set role = excluded.role,
        status = case when employer_workspace_members.status = 'revoked'
                      then 'invited' else employer_workspace_members.status end,
        contact_id = excluded.contact_id
  returning id into v_id;

  -- The workspace stops being dark the moment somebody is invited into it.
  update employer_workspaces
     set status = 'active', activated_at = coalesce(activated_at, now())
   where employer_id = p_employer_id and status = 'dark';

  return v_id;
end $$;

revoke all on function public.workspace_invite_member(uuid, uuid, text) from public, anon;
grant execute on function public.workspace_invite_member(uuid, uuid, text) to authenticated;

-- VERIFIED by role simulation against throwaway fixtures:
--   invited member  -> sees their employer, role, agent and messages; the
--                      invitation flips to 'active' on that first call
--   revoked member  -> null
--   stranger        -> null, and workspace_send_message returns false
--   live member reading employers / messages / contacts / deals / members /
--                      carriers DIRECTLY -> 0 rows on every one
-- Fixtures deleted afterwards.
