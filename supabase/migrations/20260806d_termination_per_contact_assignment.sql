-- Place each contact individually when terminating, not just the whole book.
--
-- Ken, 2026-08-06, while the first version was being tested:
--   "when a Broker Owner suspends or terminates an agent, immediately at that
--    point is when a list of contacts, (Deals, appointments, booking intents,
--    and any contacts with any type of current activity listed first), should
--    be brought up in a list for the broker dealer to transfer to themselves
--    or agents. of course a bulk transfer should be an option as well."
--
-- The first cut sent the whole book to one person. That is the common case,
-- but it is the wrong thing to force: a book usually gets split because one
-- client is mid-application with an agent who already knows them.
--
-- Supersedes the terminate_agent in 20260806c. The three-argument version is
-- dropped rather than left in place -- two functions with the same name and
-- different behaviour is how a caller ends up on the old path by accident.
--
-- Applied to production 2026-08-06 as `termination_per_contact_assignment`.

-- What the broker owner is deciding about. Ordered the way Ken asked: live
-- business first, because those are the ones where handing them to the wrong
-- agent actually costs something.
create or replace function public.termination_book(p_agent_id uuid)
returns table (
  contact_id       uuid,
  name             text,
  email            text,
  phone            text,
  type             text,
  open_deals       integer,
  next_appointment timestamptz,
  opted_out        boolean,
  has_activity     boolean
)
language plpgsql stable security definer
set search_path to 'public'
as $$
begin
  if not public.can_terminate_agent(p_agent_id) then
    raise exception 'not allowed to terminate this agent' using errcode = '42501';
  end if;

  return query
  select c.id, c.name, c.email, c.phone, c.type,
         coalesce(d.n, 0)::integer,
         b.next_at,
         coalesce(c.opt_out_email, false),
         (coalesce(d.n, 0) > 0 or b.next_at is not null)
  from public.contacts c
  left join lateral (
    select count(*) as n from public.deals dd
    where dd.contact_id = c.id and dd.agent_id = p_agent_id and dd.closed_at is null
  ) d on true
  left join lateral (
    select min(bb.scheduled_at) as next_at from public.booking_intents bb
    where bb.contact_id = c.id and bb.agent_id = p_agent_id
      and bb.completed_at is null and coalesce(bb.scheduled_at, now()) >= now()
  ) b on true
  where c.agent_id = p_agent_id
  order by (coalesce(d.n,0) > 0 or b.next_at is not null) desc,
           b.next_at nulls last,
           coalesce(d.n,0) desc,
           c.name;
end;
$$;

revoke all on function public.termination_book(uuid) from public, anon;
grant execute on function public.termination_book(uuid) to authenticated;


-- p_assignments is [{"contact_id": "...", "to_agent_id": "..."}, ...]. Anything
-- not named in it goes to p_to_agent, so the bulk case stays a single argument
-- and the caller only sends the exceptions.
create or replace function public.terminate_agent(
  p_agent_id uuid, p_to_agent uuid default null, p_reason text default null,
  p_assignments jsonb default null)
returns jsonb
language plpgsql
security definer
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
  v_split    integer := 0;
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
  if v_to = p_agent_id then
    raise exception 'cannot hand the book back to the agent being terminated' using errcode = '22023';
  end if;

  -- Who gets what. Everyone defaults to v_to; named exceptions override.
  drop table if exists _term_map;
  create temp table _term_map (contact_id uuid primary key, to_agent uuid not null) on commit drop;

  insert into _term_map (contact_id, to_agent)
  select c.id, v_to from public.contacts c where c.agent_id = p_agent_id;

  if p_assignments is not null and jsonb_typeof(p_assignments) = 'array' then
    update _term_map m
       set to_agent = nullif(a.value ->> 'to_agent_id', '')::uuid
      from jsonb_array_elements(p_assignments) a
     where m.contact_id = nullif(a.value ->> 'contact_id', '')::uuid
       and nullif(a.value ->> 'to_agent_id', '') is not null;
    select count(*) into v_split from _term_map where to_agent <> v_to;
  end if;

  -- Every recipient must be someone this person was entitled to choose. Without
  -- this, a broker owner could post an assignment naming an agent in another
  -- office and move a contact clean out of their own agency -- the dropdown
  -- would never offer it, but the dropdown is not a security control. Verified
  -- 2026-08-06 by attempting exactly that as TEST Broker Owner: refused.
  if exists (
    select 1 from (select distinct to_agent from _term_map) m
    where m.to_agent not in (select s.id from public.termination_successors(p_agent_id) s)
  ) then
    raise exception 'one of the receiving agents is not available for this transfer'
      using errcode = '42501';
  end if;
  -- v_to itself is covered by that rule when the book is non-empty; when it is
  -- empty the map is empty too, so check it directly as well.
  if not exists (select 1 from public.agents where id = v_to and status = 'active') then
    raise exception 'the receiving agent is not active' using errcode = '22023';
  end if;

  -- Record every contact before it moves, so reinstatement knows where it came from.
  insert into public.contact_transfers (contact_id, from_agent_id, to_agent_id, reason, transferred_by)
  select m.contact_id, p_agent_id, m.to_agent, 'termination', v_me.id from _term_map m;
  get diagnostics v_contacts = row_count;

  -- An introduction is owed where there is live business: an open deal, or an
  -- appointment still ahead of them. It comes from whoever actually received
  -- that contact, not from the default recipient. Opted-out clients get none --
  -- Ken's rule, and it is not softened by calling this a service notice.
  insert into public.agent_transfer_notices (contact_id, from_agent_id, to_agent_id, reason)
  select distinct on (c.id) c.id, p_agent_id, m.to_agent,
         case when d.id is not null then 'open_deal' else 'appointment' end
  from public.contacts c
  join _term_map m on m.contact_id = c.id
  left join public.deals d
    on d.contact_id = c.id and d.agent_id = p_agent_id and d.closed_at is null
  left join public.booking_intents b
    on b.contact_id = c.id and b.agent_id = p_agent_id
   and b.completed_at is null and coalesce(b.scheduled_at, now()) >= now()
  where (d.id is not null or b.id is not null)
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
  update public.contacts c set agent_id = m.to_agent, updated_at = now()
    from _term_map m where c.id = m.contact_id;

  -- A deal follows its contact, so a split book does not leave a deal behind
  -- with someone who no longer holds the person it belongs to.
  update public.deals d set agent_id = m.to_agent
    from _term_map m
   where d.contact_id = m.contact_id and d.agent_id = p_agent_id and d.closed_at is null;
  get diagnostics v_deals = row_count;

  update public.booking_intents b set agent_id = m.to_agent
    from _term_map m
   where b.contact_id = m.contact_id and b.agent_id = p_agent_id and b.completed_at is null;
  get diagnostics v_appts = row_count;

  -- Anything of theirs not hanging off one of their own contacts -- a deal on a
  -- contact somebody else holds -- would otherwise be stranded on a dead agent.
  update public.deals set agent_id = v_to where agent_id = p_agent_id and closed_at is null;
  update public.booking_intents set agent_id = v_to where agent_id = p_agent_id and completed_at is null;

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
    'contacts_assigned_individually', v_split,
    'open_deals_moved', v_deals,
    'appointments_moved', v_appts,
    'introductions_queued', v_notices,
    'introductions_skipped_opted_out', v_skipped
  );
end;
$$;

revoke all on function public.terminate_agent(uuid, uuid, text, jsonb) from public, anon;
grant execute on function public.terminate_agent(uuid, uuid, text, jsonb) to authenticated;

drop function if exists public.terminate_agent(uuid, uuid, text);
