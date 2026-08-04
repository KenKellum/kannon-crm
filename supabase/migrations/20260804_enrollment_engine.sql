-- ENROLLMENT ENGINE — applied to project ilrylhseqnllmejebozq on 2026-08-04.
--
-- A quote records what was OFFERED. An enrollment records what the client
-- actually TOOK. They are separate on purpose: a policy outlives the quote it
-- came from, can exist with no quote at all, and has a life of its own
-- (submitted -> active -> terminated) that a quote cannot express.
--
-- Enrolling LOCKS the quote behind it. From that moment its premiums, plans and
-- bullets are read-only to everyone, because that quote has become the proof of
-- what the client agreed to. A change of mind is a new quote, never an edit.

-- 1. A quote can now end in an outcome. Both outcomes lock it.
alter table public.quotes drop constraint if exists quotes_status_check;
alter table public.quotes add constraint quotes_status_check
  check (status = any (array['draft','sent','viewed','interested','expired',
                             'withdrawn','enrolled','waived']));

alter table public.quotes
  add column if not exists locked_at   timestamptz,
  add column if not exists locked_by   uuid references public.agents(id) on delete set null,
  add column if not exists enrolled_at timestamptz;

-- 2. Per product: taken or declined. A declined dental offer is recorded as
--    declined, not left absent.
alter table public.quote_options
  add column if not exists outcome      text,
  add column if not exists outcome_at   timestamptz,
  add column if not exists outcome_note text;
alter table public.quote_options drop constraint if exists quote_options_outcome_check;
alter table public.quote_options add constraint quote_options_outcome_check
  check (outcome is null or outcome = any (array['enrolled','waived']));

-- 3. The coverage record. One row per product the client actually took.
create table if not exists public.enrollments (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete restrict,
  deal_id    uuid references public.deals(id) on delete set null,
  agent_id   uuid not null references public.agents(id) on delete restrict,
  quote_id        uuid references public.quotes(id) on delete restrict,
  quote_option_id uuid references public.quote_options(id) on delete restrict,
  line            text not null,
  carrier_id      uuid references public.carriers(id) on delete set null,
  carrier_name    text not null,
  product_id      uuid references public.carrier_products(id) on delete set null,
  plan_name       text not null,
  policy_number   text,
  monthly_premium numeric,
  status text not null default 'submitted',
  applied_on   date not null default current_date,
  effective_date     date,
  termination_date   date,
  termination_reason text,
  covered_members jsonb,
  plan_snapshot   jsonb,
  source text not null default 'quote',
  agent_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint enrollments_status_check
    check (status = any (array['submitted','active','terminated','withdrawn'])),
  constraint enrollments_source_check
    check (source = any (array['quote','manual'])),
  constraint enrollments_terminated_needs_a_date
    check (status <> 'terminated' or termination_date is not null)
);

create unique index if not exists enrollments_one_per_quote_option
  on public.enrollments(quote_option_id) where quote_option_id is not null;
create index if not exists enrollments_contact_idx on public.enrollments(contact_id);
create index if not exists enrollments_deal_idx    on public.enrollments(deal_id);
create index if not exists enrollments_status_idx  on public.enrollments(status);

alter table public.enrollments enable row level security;

drop policy if exists "agents manage the enrollments they can see" on public.enrollments;
create policy "agents manage the enrollments they can see" on public.enrollments
  for all to authenticated
  using (can_see_agent_work(agent_id))
  with check (can_see_agent_work(agent_id));

-- Nothing public reaches this table. The client portal, when it exists, gets a
-- named security-definer function returning that client's own rows — never a
-- table grant.
revoke all on public.enrollments from anon;
revoke all on public.enrollments from public;
grant select, insert, update on public.enrollments to authenticated;
-- Coverage is terminated, never deleted. Granting select/insert/update above
-- does NOT achieve that on its own: a default privilege on this schema had
-- already given authenticated ALL on any new table, and adding grants never
-- removes them. Probed, caught, revoked.
revoke delete, truncate on public.enrollments from authenticated;
revoke delete, truncate on public.enrollments from anon;

create or replace function public.touch_enrollment_updated_at()
returns trigger language plpgsql set search_path to 'public' as $fn$
begin new.updated_at = now(); return new; end $fn$;

drop trigger if exists enrollments_touch_updated_at on public.enrollments;
create trigger enrollments_touch_updated_at before update on public.enrollments
  for each row execute function public.touch_enrollment_updated_at();

-- 4. The lock. A locked quote's money and plan facts are read-only; only the
--    per-product decision and the client's own view stamps may still move.
create or replace function public.refuse_to_edit_a_locked_quote()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if old.locked_at is null then return new; end if;
  -- Unlocking is deliberate: an owner in the CRM, or the service key. Without
  -- this escape a locked row could never be recovered by a server-side caller,
  -- which has no JWT email for is_broker_owner() to read.
  if new.locked_at is null
     and (is_broker_owner() or (select auth.jwt() ->> 'email') is null) then
    return new;
  end if;
  if (new.line, new.lines, new.brand, new.valid_until, new.quote_inputs,
      new.client_name, new.client_email, new.contact_id, new.deal_id,
      new.intake_session_id, new.agent_id, new.locked_at)
     is distinct from
     (old.line, old.lines, old.brand, old.valid_until, old.quote_inputs,
      old.client_name, old.client_email, old.contact_id, old.deal_id,
      old.intake_session_id, old.agent_id, old.locked_at) then
    raise exception
      'Quote "%" is locked — the client enrolled on these numbers. Re-quote instead of editing it.',
      coalesce(old.client_name, old.id::text) using errcode = 'restrict_violation';
  end if;
  return new;
end $fn$;

drop trigger if exists a_locked_quote_is_read_only on public.quotes;
create trigger a_locked_quote_is_read_only before update on public.quotes
  for each row execute function public.refuse_to_edit_a_locked_quote();

create or replace function public.refuse_to_edit_a_locked_quote_option()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare is_locked boolean;
begin
  select q.locked_at is not null into is_locked
    from quotes q where q.id = coalesce(new.quote_id, old.quote_id);
  if not coalesce(is_locked, false) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception
      'This option is part of a locked quote and records what was offered. It cannot be deleted.'
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'INSERT' then
    raise exception
      'That quote is locked — an option cannot be added to it. Build a new quote instead.'
      using errcode = 'restrict_violation';
  end if;
  if (new.carrier_name, new.display_name, new.monthly_premium, new.benefit_bullets,
      new.plan_meta, new.line, new.sort_order, new.is_recommended,
      new.carrier_id, new.product_id, new.quote_id)
     is distinct from
     (old.carrier_name, old.display_name, old.monthly_premium, old.benefit_bullets,
      old.plan_meta, old.line, old.sort_order, old.is_recommended,
      old.carrier_id, old.product_id, old.quote_id) then
    raise exception
      'Option "%" belongs to a locked quote and cannot be changed. Re-quote instead.',
      coalesce(old.display_name, old.id::text) using errcode = 'restrict_violation';
  end if;
  return new;
end $fn$;

drop trigger if exists a_locked_quotes_options_are_read_only on public.quote_options;
create trigger a_locked_quotes_options_are_read_only
  before insert or update or delete on public.quote_options
  for each row execute function public.refuse_to_edit_a_locked_quote_option();

-- 5. The public quote link must never write to a locked quote — otherwise a
--    stale tab left open on a client's screen trips the guard and the page 500s.
create or replace function public.quote_mark_interested(p_quote uuid, p_option_ids uuid[])
returns boolean language plpgsql security definer set search_path to 'public' as $fn$
begin
  update quote_options o set client_selected_at = now()
   where o.quote_id = p_quote and o.id = any(p_option_ids)
     and exists (select 1 from quotes q where q.id = p_quote and q.locked_at is null);
  update quotes set status = 'interested'
   where id = p_quote and status in ('sent','viewed') and locked_at is null;
  return true;
end $fn$;

create or replace function public.quote_request_refresh(p_quote uuid)
returns boolean language plpgsql security definer set search_path to 'public' as $fn$
begin
  update quotes set refresh_requested_at = now()
  where id = p_quote and refresh_requested_at is null and locked_at is null;
  return true;
end $fn$;

-- 6. Enrolling and terminating land on the client's timeline by themselves.
create or replace function public.log_enrollment_activity()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare kind text; subj text;
begin
  if tg_op = 'INSERT' then
    kind := 'enrolled';
  elsif new.status is distinct from old.status then
    kind := case new.status
              when 'terminated' then 'coverage_terminated'
              when 'active'     then 'coverage_activated'
              else 'coverage_updated' end;
  else
    return new;
  end if;
  subj := new.plan_name || ' — ' || new.carrier_name;
  insert into activities (contact_id, agent_id, activity_type, subject, body_snippet,
                          metadata, source, read_at)
  values (new.contact_id, new.agent_id, kind, subj,
          new.line || coalesce(' · $' || trim(to_char(new.monthly_premium, 'FM999999990.00')) || '/mo', ''),
          jsonb_build_object('enrollment_id', new.id, 'deal_id', new.deal_id,
                             'quote_id', new.quote_id, 'line', new.line,
                             'status', new.status),
          'system', now());
  return new;
end $fn$;

drop trigger if exists enrollments_land_on_the_timeline on public.enrollments;
create trigger enrollments_land_on_the_timeline after insert or update on public.enrollments
  for each row execute function public.log_enrollment_activity();

-- 7. These four only ever run from a trigger, but Postgres grants EXECUTE on
--    new functions to anon and authenticated by default, which publishes them
--    at /rest/v1/rpc/<name>. Nothing should be able to call them by name.
revoke execute on function public.refuse_to_edit_a_locked_quote()        from anon, authenticated, public;
revoke execute on function public.refuse_to_edit_a_locked_quote_option() from anon, authenticated, public;
revoke execute on function public.log_enrollment_activity()              from anon, authenticated, public;
revoke execute on function public.touch_enrollment_updated_at()          from anon, authenticated, public;
