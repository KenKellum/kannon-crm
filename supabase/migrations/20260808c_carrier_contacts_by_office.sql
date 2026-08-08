-- Ken: "it is only for the system owner, what about Broker offices. they could
-- have different reps that they send the RFP's to???"
--
-- He is right and I got this wrong. I mirrored the carriers policy — every agent
-- reads, only the system owner writes — without asking who the REP belongs to.
-- A carrier is one company everywhere. The person who quotes Bozeman's groups is
-- not the person who quotes Goodyear's, and a broker owner should not have to
-- ask the system owner to add their own rep. That is precisely the kind of
-- bottleneck that ends with reps kept in somebody's phone instead of the CRM.
--
-- The precedent already exists: agency_carriers scopes carriers per office. So
-- contacts and agreements gain an agency_id.
--
--   agency_id NULL  = shared. The system owner's; every office sees it. Good for
--                     a national new-business desk that really is the same
--                     number for everyone.
--   agency_id SET   = that office's own rep. Only that office sees it, and its
--                     broker owner maintains it without involving anyone else.
--
-- SEAT scoped, not agents.agency_id. my_agency_id() returns the PRIMARY office
-- only, so an agent seated in two offices would silently lose one — the exact
-- trap this project has hit before. my_agency_ids() below reads agent_agencies,
-- which is the seat table.
--
-- Templates stay shared on purpose: a carrier's census layout is the CARRIER's,
-- identical whoever sends it. Scoping those per office would mean three copies
-- of one spreadsheet format quietly drifting apart.
--
-- PROVEN, not reasoned about — five probes, each impersonating a real seat and
-- rolled back afterwards (0 rows left behind):
--   1. Broker owner (Rival Office) reads the shared desk and NOT the Insured
--      America rep.                                              PASS
--   2. Broker owner inserts a rep for their OWN office.          ALLOWED
--   3. Broker owner inserts into ANOTHER office.                 REFUSED 42501
--   4. Broker owner inserts a SHARED (null) record.              REFUSED 42501
--   5. Plain agent in that office inserts anything.              REFUSED 42501
--   6. anon reads either table.                                  REFUSED 42501

create or replace function public.my_agency_ids()
returns setof uuid language sql stable security definer set search_path to 'public'
as $$
  select aa.agency_id
    from agent_agencies aa
    join agents a on a.id = aa.agent_id
   where lower(a.email) = lower(auth.jwt() ->> 'email');
$$;

revoke all on function public.my_agency_ids() from public;
revoke execute on function public.my_agency_ids() from anon;
grant execute on function public.my_agency_ids() to authenticated;
grant execute on function public.my_agency_ids() to service_role;


alter table carrier_contacts
  add column if not exists agency_id uuid references agencies(id) on delete cascade;
alter table carrier_agreements
  add column if not exists agency_id uuid references agencies(id) on delete cascade;

comment on column carrier_contacts.agency_id is
  'NULL = shared across every office (system owner). Set = that office''s own rep, maintained by its broker owner.';

-- The old uniqueness said one email per carrier full stop, which would have
-- stopped two offices each holding their own rep at the same address — or worse,
-- let one office overwrite another's. Uniqueness is per office now, with a
-- partial index covering the shared rows where agency_id is null.
alter table carrier_contacts drop constraint if exists carrier_contacts_carrier_id_email_key;
create unique index if not exists carrier_contacts_office_email_idx
  on carrier_contacts (carrier_id, agency_id, lower(email))
  where agency_id is not null;
create unique index if not exists carrier_contacts_shared_email_idx
  on carrier_contacts (carrier_id, lower(email))
  where agency_id is null;
create index if not exists carrier_contacts_agency_idx on carrier_contacts(agency_id);
create index if not exists carrier_agreements_agency_idx on carrier_agreements(agency_id);


-- ── RLS, rewritten ───────────────────────────────────────────────────────
drop policy if exists "agents read carrier contacts"        on carrier_contacts;
drop policy if exists "system owner writes carrier contacts" on carrier_contacts;
drop policy if exists "agents read carrier agreements"       on carrier_agreements;
drop policy if exists "system owner writes carrier agreements" on carrier_agreements;

-- Read: the shared ones, plus the offices you actually hold a seat in.
create policy "agents read carrier contacts" on carrier_contacts
  for select to authenticated
  using (is_an_agent()
         and (agency_id is null or agency_id in (select my_agency_ids())));

-- The system owner owns the shared list and can reach anything.
create policy "system owner writes carrier contacts" on carrier_contacts
  for all to authenticated
  using (is_system_owner()) with check (is_system_owner());

-- A broker owner maintains their OWN office's reps. agency_id is not null in the
-- check, so they cannot create or edit a shared record — that would put a rep in
-- front of every other office in the company.
create policy "broker owner writes own office contacts" on carrier_contacts
  for all to authenticated
  using (is_broker_owner() and agency_id is not null
         and agency_id in (select my_agency_ids()))
  with check (is_broker_owner() and agency_id is not null
              and agency_id in (select my_agency_ids()));

create policy "agents read carrier agreements" on carrier_agreements
  for select to authenticated
  using (is_an_agent()
         and (agency_id is null or agency_id in (select my_agency_ids())));

create policy "system owner writes carrier agreements" on carrier_agreements
  for all to authenticated
  using (is_system_owner()) with check (is_system_owner());

create policy "broker owner writes own office agreements" on carrier_agreements
  for all to authenticated
  using (is_broker_owner() and agency_id is not null
         and agency_id in (select my_agency_ids()))
  with check (is_broker_owner() and agency_id is not null
              and agency_id in (select my_agency_ids()));
