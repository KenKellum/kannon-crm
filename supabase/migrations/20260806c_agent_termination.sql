-- Terminating and reinstating an agent.
--
-- Ken, 2026-08-06: "only broker owners and the system admin should be able to
-- suspend or terminate an agents account."
--
-- The shape of it, decided with him:
--   * the book goes to whoever does the terminating, unless they name someone
--     else in the same office
--   * sequences already running carry on, sent from whoever now holds the
--     contact -- they follow the contact, so this happens by itself
--   * clients with live business (an open deal, or an appointment still ahead)
--     are owed an introduction from their new agent
--   * a client who opted out of email gets NO introduction. Ken's words: "if
--     the client is opted out, then we do not send an introduction email!"
--     Not softened by calling it a service notice.
--   * the login is SUSPENDED, never deleted, because a broker owner may
--     reinstate them later and you cannot un-delete an account
--   * every contact records who held it before the move, so a reinstatement
--     can hand the book back
--   * their public card comes down and points visitors at the new agent
--     instead of 404ing
--
-- Nothing is ever deleted. Signed SOAs carry a ten-year retention rule.
--
-- Applied to production 2026-08-06 as migrations `agent_termination_and_
-- reinstatement` and `agent_termination_preview`. This file is the record of
-- what those did.

-- ---------------------------------------------------------------- columns --
alter table public.agents
  add column if not exists terminated_at      timestamptz,
  add column if not exists terminated_by      uuid references public.agents(id),
  add column if not exists terminated_reason  text,
  add column if not exists successor_agent_id uuid references public.agents(id),
  add column if not exists reinstated_at      timestamptz;

-- A single previous_agent_id would not survive A -> B -> C: B would overwrite
-- A and the trail back would be gone. Since handing the book back is the whole
-- point of keeping it, this is a history, not a field.
create table if not exists public.contact_transfers (
  id             uuid primary key default gen_random_uuid(),
  contact_id     uuid not null references public.contacts(id) on delete cascade,
  from_agent_id  uuid references public.agents(id),
  to_agent_id    uuid references public.agents(id),
  reason         text not null,
  transferred_by uuid references public.agents(id),
  transferred_at timestamptz not null default now()
);
create index if not exists contact_transfers_contact_idx on public.contact_transfers(contact_id);
create index if not exists contact_transfers_from_idx    on public.contact_transfers(from_agent_id);

-- Introductions are QUEUED, not sent. There is no outbound mail queue in the
-- database -- Apps Script sends directly -- so these rows sit here until an
-- Apps Script job drains them through the branded shell (kfgEmailHeader_).
-- Until that job exists, this table is a to-do list somebody must action.
create table if not exists public.agent_transfer_notices (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid not null references public.contacts(id) on delete cascade,
  from_agent_id uuid references public.agents(id),
  to_agent_id   uuid references public.agents(id),
  reason        text not null,
  status        text not null default 'queued',
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create index if not exists agent_transfer_notices_status_idx on public.agent_transfer_notices(status);

alter table public.contact_transfers      enable row level security;
alter table public.agent_transfer_notices enable row level security;

-- Read-only to the app. Both tables are written solely by the SECURITY DEFINER
-- functions below, so there is deliberately no insert/update/delete policy:
-- an audit trail an agent can edit is not an audit trail.
drop policy if exists contact_transfers_read on public.contact_transfers;
create policy contact_transfers_read on public.contact_transfers
  for select to authenticated
  using (exists (select 1 from public.contacts c
                 where c.id = contact_id and public.can_see_contact(c.id)));

drop policy if exists agent_transfer_notices_read on public.agent_transfer_notices;
create policy agent_transfer_notices_read on public.agent_transfer_notices
  for select to authenticated
  using (exists (select 1 from public.contacts c
                 where c.id = contact_id and public.can_see_contact(c.id)));

-- -------------------------------------------------------------- who may -----
-- The whole security model in one function. Three refusals matter:
--   * you cannot terminate yourself (t.id <> me.id) -- otherwise a broker
--     owner could lock themselves out and orphan their own office
--   * nobody can terminate the system owner
--   * a broker owner reaches only offices they are seated in. This is the one
--     that would be a serious hole if it were wrong, so it is tested against
--     real agents in two different offices, not assumed.
create or replace function public.can_terminate_agent(p_target uuid)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.agents me, public.agents t
    where me.email = (select auth.jwt() ->> 'email')
      and t.id = p_target
      and t.id <> me.id
      and t.role <> 'system_owner'
      and (
            me.role = 'system_owner'
         or (me.role in ('broker_owner', 'agency_owner')
             and exists (
               select 1
               from (select agency_id from public.agent_agencies where agent_id = me.id
                     union select me.agency_id where me.agency_id is not null) mine
               join (select agency_id from public.agent_agencies where agent_id = t.id
                     union select t.agency_id where t.agency_id is not null) theirs
                 on theirs.agency_id = mine.agency_id))
          )
  );
$$;

revoke all on function public.can_terminate_agent(uuid) from public, anon;
grant execute on function public.can_terminate_agent(uuid) to authenticated;

-- ------------------------------------------------------------- terminate ----
create or replace function public.terminate_agent(
  p_agent_id uuid, p_to_agent uuid default null, p_reason text default null)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_me       public.agents%rowtype;
  v_to       uuid;
  v_contacts integer := 0;
  v_deals    integer := 0;
  v_appts    integer := 0;
  v_notices  integer := 0;
  v_skipped  integer := 0;
begin
  select * into v_me from public.agents a
  where a.email = (select auth.jwt() ->> 'email') limit 1;
  if not found then
    raise exception 'not an agent' using errcode = '42501';
  end if;

  if not public.can_terminate_agent(p_agent_id) then
    raise exception 'not allowed to terminate this agent' using errcode = '42501';
  end if;

  if not exists (select 1 from public.agents where id = p_agent_id and status = 'active') then
    raise exception 'that agent is not active' using errcode = '22023';
  end if;

  -- The book goes to the person doing this unless they nominate someone else.
  v_to := coalesce(p_to_agent, v_me.id);
  if not exists (select 1 from public.agents where id = v_to and status = 'active') then
    raise exception 'the receiving agent is not active' using errcode = '22023';
  end if;
  if v_to = p_agent_id then
    raise exception 'cannot hand the book back to the agent being terminated' using errcode = '22023';
  end if;

  -- Record every contact before it moves, so reinstatement knows where it came from.
  insert into public.contact_transfers (contact_id, from_agent_id, to_agent_id, reason, transferred_by)
  select c.id, c.agent_id, v_to, 'termination', v_me.id
  from public.contacts c where c.agent_id = p_agent_id;
  get diagnostics v_contacts = row_count;

  -- An introduction is owed where there is live business: an open deal, or an
  -- appointment still ahead of them. Opted-out clients get none -- Ken's rule,
  -- and it is not softened by calling this a service notice.
  insert into public.agent_transfer_notices (contact_id, from_agent_id, to_agent_id, reason)
  select distinct on (c.id) c.id, p_agent_id, v_to,
         case when d.id is not null then 'open_deal' else 'appointment' end
  from public.contacts c
  left join public.deals d
    on d.contact_id = c.id and d.agent_id = p_agent_id and d.closed_at is null
  left join public.booking_intents b
    on b.contact_id = c.id and b.agent_id = p_agent_id
   and b.completed_at is null and coalesce(b.scheduled_at, now()) >= now()
  where c.agent_id = p_agent_id
    and (d.id is not null or b.id is not null)
    and coalesce(c.opt_out_email, false) = false
    and c.email is not null;
  get diagnostics v_notices = row_count;

  -- What we deliberately did not write to, for the summary.
  select count(distinct c.id) into v_skipped
  from public.contacts c
  left join public.deals d
    on d.contact_id = c.id and d.agent_id = p_agent_id and d.closed_at is null
  left join public.booking_intents b
    on b.contact_id = c.id and b.agent_id = p_agent_id
   and b.completed_at is null and coalesce(b.scheduled_at, now()) >= now()
  where c.agent_id = p_agent_id
    and (d.id is not null or b.id is not null)
    and (coalesce(c.opt_out_email, false) = true or c.email is null);

  -- Move the work. Sequences follow the contact, so they carry on from
  -- whoever now holds it rather than stopping.
  update public.contacts set agent_id = v_to, updated_at = now() where agent_id = p_agent_id;

  update public.deals set agent_id = v_to where agent_id = p_agent_id and closed_at is null;
  get diagnostics v_deals = row_count;

  update public.booking_intents set agent_id = v_to
   where agent_id = p_agent_id and completed_at is null;
  get diagnostics v_appts = row_count;

  update public.agents set
    status             = 'inactive',
    public_profile     = false,
    terminated_at      = now(),
    terminated_by      = v_me.id,
    terminated_reason  = nullif(btrim(coalesce(p_reason, '')), ''),
    successor_agent_id = v_to,
    reinstated_at      = null
  where id = p_agent_id;

  return jsonb_build_object(
    'agent_id', p_agent_id,
    'to_agent_id', v_to,
    'contacts_moved', v_contacts,
    'open_deals_moved', v_deals,
    'appointments_moved', v_appts,
    'introductions_queued', v_notices,
    'introductions_skipped_opted_out', v_skipped
  );
end;
$$;

revoke all on function public.terminate_agent(uuid, uuid, text) from public, anon;
grant execute on function public.terminate_agent(uuid, uuid, text) to authenticated;

-- ------------------------------------------------------------- reinstate ----
-- Note: public_profile is NOT switched back on. Rejoining the team and going
-- back on the website are two decisions, and the second one is theirs to make
-- from their profile.
create or replace function public.reinstate_agent(
  p_agent_id uuid, p_return_book boolean default true)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_me       public.agents%rowtype;
  v_returned integer := 0;
  v_deals    integer := 0;
  v_appts    integer := 0;
begin
  select * into v_me from public.agents a
  where a.email = (select auth.jwt() ->> 'email') limit 1;
  if not found then
    raise exception 'not an agent' using errcode = '42501';
  end if;

  -- can_terminate_agent requires the target to be terminable, which a
  -- terminated agent no longer is, so the same authority is checked directly.
  if not exists (
    select 1 from public.agents t where t.id = p_agent_id and (
      v_me.role = 'system_owner'
      or (v_me.role in ('broker_owner','agency_owner') and exists (
            select 1
            from (select agency_id from public.agent_agencies where agent_id = v_me.id
                  union select v_me.agency_id where v_me.agency_id is not null) mine
            join (select agency_id from public.agent_agencies where agent_id = t.id
                  union select t.agency_id where t.agency_id is not null) theirs
              on theirs.agency_id = mine.agency_id))
    )
  ) then
    raise exception 'not allowed to reinstate this agent' using errcode = '42501';
  end if;

  if p_return_book then
    with mine as (
      select ct.contact_id, ct.to_agent_id
      from public.contact_transfers ct
      where ct.from_agent_id = p_agent_id
        and ct.reason = 'termination'
        and ct.transferred_at = (
          select max(x.transferred_at) from public.contact_transfers x
          where x.contact_id = ct.contact_id)
    )
    update public.contacts c set agent_id = p_agent_id, updated_at = now()
    from mine
    where c.id = mine.contact_id
      -- only if nobody has moved it since
      and c.agent_id = mine.to_agent_id;
    get diagnostics v_returned = row_count;

    insert into public.contact_transfers (contact_id, from_agent_id, to_agent_id, reason, transferred_by)
    select c.id, c.agent_id, p_agent_id, 'reinstatement', v_me.id
    from public.contacts c where c.agent_id = p_agent_id;

    update public.deals d set agent_id = p_agent_id
      from public.contacts c
     where c.id = d.contact_id and c.agent_id = p_agent_id and d.closed_at is null;
    get diagnostics v_deals = row_count;

    update public.booking_intents b set agent_id = p_agent_id
      from public.contacts c
     where c.id = b.contact_id and c.agent_id = p_agent_id and b.completed_at is null;
    get diagnostics v_appts = row_count;
  end if;

  update public.agents set
    status             = 'active',
    reinstated_at      = now(),
    terminated_at      = null,
    successor_agent_id = null
  where id = p_agent_id;

  return jsonb_build_object(
    'agent_id', p_agent_id,
    'contacts_returned', v_returned,
    'open_deals_returned', v_deals,
    'appointments_returned', v_appts
  );
end;
$$;

revoke all on function public.reinstate_agent(uuid, boolean) from public, anon;
grant execute on function public.reinstate_agent(uuid, boolean) to authenticated;

-- ------------------------------------------------- the confirmation's facts --
-- The counts the confirmation dialog shows. They are copied from
-- terminate_agent deliberately rather than re-derived, so what the dialog
-- promises and what the termination does cannot drift apart. Verified equal
-- against fixtures on 2026-08-06.
--
-- Gated on can_terminate_agent for a second reason: "how big is that agent's
-- book" is not a question a colleague gets to ask.
create or replace function public.agent_termination_preview(p_agent_id uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_row      public.agents%rowtype;
  v_contacts integer := 0;
  v_deals    integer := 0;
  v_appts    integer := 0;
  v_notices  integer := 0;
  v_skipped  integer := 0;
begin
  if not public.can_terminate_agent(p_agent_id) then
    raise exception 'not allowed to terminate this agent' using errcode = '42501';
  end if;

  select * into v_row from public.agents where id = p_agent_id;
  if not found then
    raise exception 'no such agent' using errcode = '22023';
  end if;

  select count(*) into v_contacts from public.contacts where agent_id = p_agent_id;

  select count(*) into v_deals
  from public.deals where agent_id = p_agent_id and closed_at is null;

  select count(*) into v_appts
  from public.booking_intents
  where agent_id = p_agent_id and completed_at is null;

  select count(distinct c.id) into v_notices
  from public.contacts c
  left join public.deals d
    on d.contact_id = c.id and d.agent_id = p_agent_id and d.closed_at is null
  left join public.booking_intents b
    on b.contact_id = c.id and b.agent_id = p_agent_id
   and b.completed_at is null and coalesce(b.scheduled_at, now()) >= now()
  where c.agent_id = p_agent_id
    and (d.id is not null or b.id is not null)
    and coalesce(c.opt_out_email, false) = false
    and c.email is not null;

  select count(distinct c.id) into v_skipped
  from public.contacts c
  left join public.deals d
    on d.contact_id = c.id and d.agent_id = p_agent_id and d.closed_at is null
  left join public.booking_intents b
    on b.contact_id = c.id and b.agent_id = p_agent_id
   and b.completed_at is null and coalesce(b.scheduled_at, now()) >= now()
  where c.agent_id = p_agent_id
    and (d.id is not null or b.id is not null)
    and (coalesce(c.opt_out_email, false) = true or c.email is null);

  return jsonb_build_object(
    'agent_id',     p_agent_id,
    'agent_name',   v_row.name,
    'has_login',    v_row.auth_user_id is not null,
    'contacts',     v_contacts,
    'open_deals',   v_deals,
    'appointments', v_appts,
    'introductions_queued',            v_notices,
    'introductions_skipped_opted_out', v_skipped
  );
end;
$$;

revoke all on function public.agent_termination_preview(uuid) from public, anon;
grant execute on function public.agent_termination_preview(uuid) to authenticated;

-- Who may receive a book. Same gate, so this cannot become a roster listing.
create or replace function public.termination_successors(p_agent_id uuid)
returns table (id uuid, name text, role text)
language plpgsql security definer
set search_path to 'public'
as $$
begin
  if not public.can_terminate_agent(p_agent_id) then
    raise exception 'not allowed to terminate this agent' using errcode = '42501';
  end if;

  return query
  select a.id, a.name, a.role
  from public.agents a
  where a.status = 'active'
    and a.id <> p_agent_id
    and (
      exists (select 1 from public.agents me
              where me.email = (select auth.jwt() ->> 'email')
                and me.role = 'system_owner')
      or a.agency_id = (select t.agency_id from public.agents t where t.id = p_agent_id)
    )
  order by (a.role in ('broker_owner','agency_owner')) desc, a.name;
end;
$$;

revoke all on function public.termination_successors(uuid) from public, anon;
grant execute on function public.termination_successors(uuid) to authenticated;

-- ----------------------------------------------------- the kind card page ---
-- A client who scanned a business card months ago should not hit a 404. This
-- is the ONLY thing anon may ask about a former agent, and it returns names
-- and a slug -- no email, no phone, no reason, no dates.
create or replace function public.retired_agent_card(p_slug text)
returns table (former_name text, successor_name text, successor_slug text, successor_title text)
language sql stable security definer
set search_path to 'public'
as $$
  select
    coalesce(a.display_name, a.name),
    coalesce(s.display_name, s.name),
    s.slug,
    s.title
  from public.agents a
  join public.agents s on s.id = a.successor_agent_id
  where a.slug = p_slug
    and a.terminated_at is not null
    and a.status <> 'active'
    and s.status = 'active'
    and s.public_profile = true
    and s.slug is not null
  limit 1;
$$;

grant execute on function public.retired_agent_card(text) to anon, authenticated;
