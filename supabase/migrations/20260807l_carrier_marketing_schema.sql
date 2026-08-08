-- ============================================================
-- CENSUS -> CARRIERS.  The structures only; the workspace and the sending
-- come next. Ken's rule: "the last thing I want is ANOTHER place to do all
-- this setup work", so the group settings live ON the carrier record and
-- surface in the carrier dialog that already exists — the same way the SOA
-- block already appears only when a Medicare line is ticked.
--
-- SECURITY, designed in rather than retrofitted. Three different audiences:
--   * catalogue (carriers, their contacts, templates, agreements) — every agent
--     READS, only the system owner WRITES. Mirrors the existing carriers policy.
--   * per-employer work (rounds, submissions, responses) — SEAT scoped through
--     the employer's primary agent with can_see_agent_work(), like employers.
--   * the disclosure log — append-only to agents, and NOBODY can update or
--     delete it. An audit trail that can be edited is not an audit trail.
-- Roles are never named literally; is_system_owner()/is_an_agent() are called.
-- Carrier reps get their own door in the NEXT migration, through a definer
-- function — they never receive a table grant.
--
-- PROBED after applying, with the published anon key: all seven tables refuse
-- SELECT with 42501, and an anon INSERT into census_disclosures is refused at
-- the grant, before RLS is even consulted.
-- ============================================================

-- ── group settings, on the carrier record itself ─────────────────────────
alter table carriers
  add column if not exists is_general_agent      boolean not null default false,
  add column if not exists group_quoting_email   text,
  add column if not exists group_quoting_url     text,
  add column if not exists group_submission      text
      check (group_submission in ('workspace','portal','email','ga')),
  add column if not exists group_size_min        integer,
  add column if not exists group_size_max        integer,
  add column if not exists group_states          text[] not null default '{}',
  -- Ken's decision: SSNs are OUT by default and opted into per carrier, then
  -- confirmed again at send time. Level-funded carriers genuinely need them;
  -- most do not, and "it was in the template" is not a reason to disclose.
  add column if not exists group_wants_ssn       boolean not null default false,
  add column if not exists group_notes           text;

comment on column carriers.group_wants_ssn is
  'Opt-in only. Even when true the agent confirms at send time and the disclosure is logged.';


-- ── the PEOPLE at a carrier or GA. Reps move; carriers do not. ───────────
-- Access is per person, so revoking one rep disturbs nobody else. A rep who
-- covers several carriers gets a row per carrier rather than a shared login.
create table if not exists carrier_contacts (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid not null references carriers(id) on delete cascade,
  name          text not null,
  email         text not null,
  phone         text,
  title         text,
  role          text not null default 'quoting'
                check (role in ('quoting','underwriting','service','sales','other')),
  is_active     boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now(),
  unique (carrier_id, email)
);
create index if not exists carrier_contacts_carrier_idx on carrier_contacts(carrier_id);


-- ── how each carrier wants the census laid out ───────────────────────────
-- The mapping is stored, not a spreadsheet: the file is GENERATED from the
-- frozen census revision at download time. One carrier changing a heading is
-- an edit here, not a re-export of every group.
-- columns: [{header, field, format}] in the order the carrier wants them.
create table if not exists carrier_census_templates (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid references carriers(id) on delete cascade,
  name          text not null,
  -- null carrier_id + is_default marks OUR fallback layout, used for every
  -- carrier that never supplied one.
  is_default    boolean not null default false,
  file_format   text not null default 'xlsx' check (file_format in ('xlsx','csv')),
  columns       jsonb not null default '[]'::jsonb,
  includes_ssn  boolean not null default false,
  sample_url    text,
  notes         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists carrier_census_templates_carrier_idx
  on carrier_census_templates(carrier_id);


-- ── the agreement on file. Generic on purpose. ───────────────────────────
-- A GA handling PHI for us is usually a business associate (BAA). A carrier
-- underwriting a group is generally a covered entity in its own right, which
-- is a different document. Ken is asking his attorney which is which; the type
-- column means that answer changes a value, not a schema.
-- A new version re-triggers signature, exactly as Ken described.
create table if not exists carrier_agreements (
  id            uuid primary key default gen_random_uuid(),
  carrier_id    uuid not null references carriers(id) on delete cascade,
  kind          text not null default 'baa'
                check (kind in ('baa','confidentiality','data_sharing','other')),
  version       text not null default '1.0',
  status        text not null default 'pending'
                check (status in ('pending','signed','expired','superseded')),
  signed_by     text,
  signed_email  text,
  signed_at     timestamptz,
  document_url  text,
  notes         text,
  created_at    timestamptz not null default now()
);
create index if not exists carrier_agreements_carrier_idx on carrier_agreements(carrier_id);


-- ── one go-to-market for one employer ────────────────────────────────────
-- census_revision is the whole point: what a carrier quoted must stay exactly
-- as it was sent, and census_revisions already snapshots every submission in
-- full. Round 2 is Ken's "re-activate to send new RFPs for the same group".
create table if not exists marketing_rounds (
  id                uuid primary key default gen_random_uuid(),
  employer_id       uuid not null references employers(id) on delete cascade,
  census_request_id uuid references census_requests(id) on delete set null,
  census_revision   integer,
  round_no          integer not null default 1,
  effective_date    date,
  products_wanted   text[] not null default '{}',
  status            text not null default 'draft'
                    check (status in ('draft','sent','quoting','closed','cancelled')),
  opened_by         uuid references agents(id),
  opened_at         timestamptz not null default now(),
  closed_at         timestamptz,
  notes             text,
  unique (employer_id, round_no)
);
create index if not exists marketing_rounds_employer_idx on marketing_rounds(employer_id);


-- ── one carrier's involvement in one round ───────────────────────────────
-- method records how it ACTUALLY went out. The workspace is the default, but a
-- rep who refuses to log in still gets recorded here as 'email' rather than
-- vanishing into Gmail — the record is the point, the delivery is negotiable.
create table if not exists marketing_submissions (
  id             uuid primary key default gen_random_uuid(),
  round_id       uuid not null references marketing_rounds(id) on delete cascade,
  carrier_id     uuid not null references carriers(id),
  contact_id     uuid references carrier_contacts(id),
  template_id    uuid references carrier_census_templates(id),
  method         text not null default 'workspace'
                 check (method in ('workspace','portal','email','ga')),
  with_ssn       boolean not null default false,
  status         text not null default 'pending'
                 check (status in ('pending','sent','viewed','downloaded',
                                   'acknowledged','quoted','declined','withdrawn')),
  sent_at        timestamptz,
  first_viewed_at timestamptz,
  downloaded_at  timestamptz,
  responded_at   timestamptz,
  decline_reason text,
  notes          text,
  created_at     timestamptz not null default now(),
  unique (round_id, carrier_id)
);
create index if not exists marketing_submissions_round_idx on marketing_submissions(round_id);


-- ── what came back ───────────────────────────────────────────────────────
-- normalised is filled by the AI pass in a later phase and is ALWAYS reviewable
-- against the original document — the same "AI proposes, a person approves"
-- shape the brochure extractor already uses.
create table if not exists rfp_responses (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references marketing_submissions(id) on delete cascade,
  file_url       text,
  file_name      text,
  received_at    timestamptz not null default now(),
  uploaded_by    text,
  normalised     jsonb,
  reviewed_by    uuid references agents(id),
  reviewed_at    timestamptz,
  notes          text
);
create index if not exists rfp_responses_submission_idx on rfp_responses(submission_id);


-- ── the accounting of disclosures ────────────────────────────────────────
-- Under a signed BAA this is an obligation, not a nicety. Today that accounting
-- is "somewhere in Gmail". Append-only: agents may INSERT and READ, and there
-- is deliberately no UPDATE or DELETE policy for anyone.
create table if not exists census_disclosures (
  id                uuid primary key default gen_random_uuid(),
  employer_id       uuid not null references employers(id) on delete cascade,
  census_request_id uuid references census_requests(id) on delete set null,
  census_revision   integer,
  submission_id     uuid references marketing_submissions(id) on delete set null,
  carrier_id        uuid references carriers(id),
  disclosed_to      text,
  method            text,
  included_ssn      boolean not null default false,
  row_count         integer,
  disclosed_by      uuid references agents(id),
  disclosed_at      timestamptz not null default now(),
  notes             text
);
create index if not exists census_disclosures_employer_idx on census_disclosures(employer_id);


-- ============================================================
-- RLS — in the same migration that creates the tables.
-- ============================================================
alter table carrier_contacts          enable row level security;
alter table carrier_census_templates  enable row level security;
alter table carrier_agreements        enable row level security;
alter table marketing_rounds          enable row level security;
alter table marketing_submissions     enable row level security;
alter table rfp_responses             enable row level security;
alter table census_disclosures        enable row level security;

-- Catalogue: every agent reads, the system owner writes. Same shape as carriers.
create policy "agents read carrier contacts"      on carrier_contacts
  for select to authenticated using (is_an_agent());
create policy "system owner writes carrier contacts" on carrier_contacts
  for all to authenticated using (is_system_owner()) with check (is_system_owner());

create policy "agents read census templates"      on carrier_census_templates
  for select to authenticated using (is_an_agent());
create policy "system owner writes census templates" on carrier_census_templates
  for all to authenticated using (is_system_owner()) with check (is_system_owner());

create policy "agents read carrier agreements"    on carrier_agreements
  for select to authenticated using (is_an_agent());
create policy "system owner writes carrier agreements" on carrier_agreements
  for all to authenticated using (is_system_owner()) with check (is_system_owner());

-- Per-employer work: seat scoped, exactly like the employer record itself.
create policy "seat scoped marketing rounds" on marketing_rounds
  for all to authenticated
  using (exists (select 1 from employers e
                  where e.id = marketing_rounds.employer_id
                    and can_see_agent_work(e.primary_agent_id)))
  with check (exists (select 1 from employers e
                       where e.id = marketing_rounds.employer_id
                         and can_see_agent_work(e.primary_agent_id)));

create policy "seat scoped marketing submissions" on marketing_submissions
  for all to authenticated
  using (exists (select 1 from marketing_rounds r join employers e on e.id = r.employer_id
                  where r.id = marketing_submissions.round_id
                    and can_see_agent_work(e.primary_agent_id)))
  with check (exists (select 1 from marketing_rounds r join employers e on e.id = r.employer_id
                       where r.id = marketing_submissions.round_id
                         and can_see_agent_work(e.primary_agent_id)));

create policy "seat scoped rfp responses" on rfp_responses
  for all to authenticated
  using (exists (select 1 from marketing_submissions s
                   join marketing_rounds r on r.id = s.round_id
                   join employers e on e.id = r.employer_id
                  where s.id = rfp_responses.submission_id
                    and can_see_agent_work(e.primary_agent_id)))
  with check (exists (select 1 from marketing_submissions s
                        join marketing_rounds r on r.id = s.round_id
                        join employers e on e.id = r.employer_id
                       where s.id = rfp_responses.submission_id
                         and can_see_agent_work(e.primary_agent_id)));

-- Append-only. SELECT and INSERT only — no UPDATE or DELETE policy exists for
-- anyone, so the log cannot be rewritten after the fact.
create policy "agents read disclosures" on census_disclosures
  for select to authenticated
  using (exists (select 1 from employers e
                  where e.id = census_disclosures.employer_id
                    and can_see_agent_work(e.primary_agent_id)));
create policy "agents record disclosures" on census_disclosures
  for insert to authenticated
  with check (exists (select 1 from employers e
                       where e.id = census_disclosures.employer_id
                         and can_see_agent_work(e.primary_agent_id)));

-- anon gets NOTHING here. Named explicitly rather than assumed: the default
-- privileges on this schema are generous and have caught me out already.
revoke all on carrier_contacts, carrier_census_templates, carrier_agreements,
              marketing_rounds, marketing_submissions, rfp_responses,
              census_disclosures
  from anon;
