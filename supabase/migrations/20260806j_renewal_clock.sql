-- Phase 4: the renewal clock, 2026-08-06.
--
-- Group benefits is a calendar business. Deals are won 90-120 days before the
-- employer's renewal, not whenever a sequence happens to fire. Everything here
-- answers one question: WHO SHOULD I BE WORKING THIS MONTH.
--
-- No Apps Script deploy is needed. The pacer already skips a contact whose
-- sequence_paused_until is in the future ("skip contacts with a paused
-- sequence"), so holding outreach is a matter of setting that date.

-- Next occurrence of a renewal, on or after today. A loop rather than clever
-- arithmetic, so leap years and month lengths are Postgres's problem: a
-- 29 February renewal lands on 28 February in a common year instead of raising.
create or replace function public.employer_next_renewal(
  p_renewal_date date, p_renewal_month smallint, p_today date default current_date)
returns date language plpgsql immutable as $$
declare v date; guard int := 0;
begin
  if p_renewal_date is not null then v := p_renewal_date;
  elsif p_renewal_month is not null then
    v := make_date(extract(year from p_today)::int, p_renewal_month, 1);
  else return null;
  end if;

  while v < p_today and guard < 200 loop
    v := (v + interval '1 year')::date;
    guard := guard + 1;
  end loop;
  return v;
end $$;

revoke all on function public.employer_next_renewal(date, smallint, date) from public, anon;
grant execute on function public.employer_next_renewal(date, smallint, date) to authenticated;

-- security_invoker so this reads under the CALLER's row security on employers.
-- A view that runs as its owner is exactly the hole fixed in 20260806h.
create or replace view public.employer_renewal_windows
with (security_invoker = true) as
select
  e.id                                    as employer_id,
  e.legal_name,
  e.dba,
  e.primary_agent_id,
  e.size_class,
  e.current_carrier,
  e.renewal_date,
  e.renewal_month,
  r.next_renewal,
  (r.next_renewal - 120)                  as window_opens_on,
  (r.next_renewal - current_date)         as days_to_renewal,
  ((r.next_renewal - 120) - current_date) as days_until_window,
  case
    when r.next_renewal is null               then 'unknown'
    when r.next_renewal - current_date <  30  then 'too late this year'
    when r.next_renewal - current_date <= 120 then 'work now'
    when r.next_renewal - current_date <= 150 then 'opens soon'
    else 'waiting'
  end as window_state
from public.employers e
cross join lateral (
  select public.employer_next_renewal(e.renewal_date, e.renewal_month) as next_renewal
) r;

grant select on public.employer_renewal_windows to authenticated;
revoke all  on public.employer_renewal_windows from anon;

-- ── qualification ────────────────────────────────────────────────────────────
-- Qualified is not a feeling. It means we know WHEN they renew, HOW BIG they
-- are, and WHO DECIDES. Until all three are true, outreach is a guess — so the
-- card stays at New Lead and the board says which box is still empty.
create or replace function public.try_qualify_employer(p_employer_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_emp employers%rowtype; v_has_decider boolean; v_deal record; v_any boolean := false;
begin
  select * into v_emp from employers where id = p_employer_id;
  if not found then return false; end if;

  if v_emp.renewal_date is null and v_emp.renewal_month is null then return false; end if;
  if v_emp.fte_count is null and v_emp.employee_count is null then return false; end if;

  select exists (select 1 from employer_contacts
                  where employer_id = p_employer_id
                    and role in ('decision_maker','benefits_admin'))
    into v_has_decider;
  if not v_has_decider then return false; end if;

  for v_deal in select id from deals
                 where employer_id = p_employer_id and closed_at is null
                   and pipeline = 'group-employer' loop
    if advance_deal_to(v_deal.id, 'Qualified',
         'Renewal month, size and a decision maker are all known.', 'qualification') then
      v_any := true;
    end if;
  end loop;
  return v_any;
end $$;

revoke all on function public.try_qualify_employer(uuid) from public, anon;
grant execute on function public.try_qualify_employer(uuid) to authenticated;

-- One trigger function, two tables, and NEW has different fields on each.
-- coalesce(new.employer_id, new.id) does NOT work — plpgsql resolves the field
-- at runtime and raises 42703 on whichever table lacks it, which took out every
-- INSERT into employers until the test caught it. Pick the field by table name.
create or replace function public.on_employer_qualifies()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if tg_table_name = 'employers' then v_id := new.id; else v_id := new.employer_id; end if;
  perform try_qualify_employer(v_id);
  return new;
end $$;

drop trigger if exists employer_qualifies on public.employers;
create trigger employer_qualifies after insert or update on public.employers
  for each row execute function public.on_employer_qualifies();

drop trigger if exists employer_contact_qualifies on public.employer_contacts;
create trigger employer_contact_qualifies after insert on public.employer_contacts
  for each row execute function public.on_employer_qualifies();

-- ── holding outreach until the window opens ──────────────────────────────────
-- The whole point of the clock: a group renewing in March is worked in
-- November, and until then it waits quietly instead of spending a first
-- impression eight months before anyone can act on it.
--
-- It only ever pushes a hold OUT, never pulls one in, so it cannot shorten a
-- pause set for another reason. Nothing needs to un-pause: a date in the past
-- is already inert. Opted-out contacts are never touched.
create or replace function public.hold_outreach_until_window(p_employer_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_opens date; v_n integer := 0;
begin
  select window_opens_on into v_opens
    from employer_renewal_windows where employer_id = p_employer_id;

  -- No renewal known, or the window is already open: let outreach run.
  if v_opens is null or v_opens <= current_date then return 0; end if;

  with touched as (
    update contacts c
       set sequence_paused_until = v_opens
      from employer_contacts ec
     where ec.employer_id = p_employer_id
       and ec.contact_id  = c.id
       and (c.sequence_paused_until is null or c.sequence_paused_until < v_opens)
       and coalesce(c.opt_out_email, false) = false
    returning c.id)
  select count(*) into v_n from touched;
  return v_n;
end $$;

revoke all on function public.hold_outreach_until_window(uuid) from public, anon;
grant execute on function public.hold_outreach_until_window(uuid) to authenticated;

comment on view public.employer_renewal_windows is
  'When each employer renews and whether we should be working them now. Group business is won 90-120 days before renewal.';

-- VERIFIED against throwaway fixtures, all PASS:
--   date rolling: March -> next year, November -> this year, 29 Feb -> 28 Feb,
--     a 2020 date rolls forward, nothing known -> null
--   size + renewal known but NO decision maker -> card stays at New Lead
--   decision maker attached -> card advances itself to Qualified
--   a March renewal reads 'waiting'; outreach held to exactly window_opens_on
--   a hold someone else set further out is NEVER shortened
--   a group already inside its window is NOT held
--   an opted-out contact is never touched
-- Anon: refused on the view and on all three functions. Fixtures deleted.
--
-- DELIBERATELY NOT DONE: the 318 existing group contacts were not bulk-held.
-- Holding them would drop Ken's outreach volume overnight — which may well be
-- correct, but it is his call, not a migration's.
