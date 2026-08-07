-- Employer records — Phase 2 of the group build, 2026-08-06.
--
-- WHY NOT `companies`: that table already holds OUR two divisions (Kannon
-- Financial Group and Insured America). Reusing the name would put clients and
-- ourselves in one table and every policy after it would have to tell them
-- apart. These are `employers` — the businesses we sell benefits to.
--
-- Created at Qualified from the agent's research, VERIFIED at census return
-- when the employer confirms their own legal name, SIC and address. Company
-- facts do not belong on a contact (a person is not a group) or on a deal (a
-- company has many deals over its life — new business, then a renewal every
-- year, then dental added later). The employer is what persists.
--
-- SECURITY, decided before any of this was written:
--
--   These tables are AGENTS ONLY, scoped by seat via can_see_agent_work().
--   `authenticated` is not a permission here — signup is open by design, so a
--   signed-in stranger must get nothing, which is why every policy also calls
--   is_an_agent().
--
--   The employer's OWN people never read these tables directly, even in a later
--   phase. RLS is row-level and cannot restrict columns, so any agent-only
--   column added later (notes, lead intel) would silently become visible to a
--   client through a table-level policy. The portal reads through a named
--   security definer function returning a fixed field list instead. The
--   membership table below exists now so that function has something to read
--   and so this boundary is designed rather than retrofitted.

-- ── employers ────────────────────────────────────────────────────────────────
create table if not exists public.employers (
  id                  uuid primary key default gen_random_uuid(),

  legal_name          text not null,
  dba                 text,
  -- Carriers require the EIN to quote and to bind, and it is the only truly
  -- unique key for a business. One EIN is one employer — enforced below.
  ein                 text,
  entity_type         text check (entity_type in
                        ('LLC','S-Corp','C-Corp','Partnership','Sole Proprietor',
                         'Non-profit','Government','Other')),
  sic_code            text,
  industry            text,

  -- Legal / mailing address. Worksites live in employer_locations, because a
  -- multi-state group is rated on where people actually work, not where the
  -- post arrives. All group sizes means multi-state is normal, not an edge case.
  street              text,
  city                text,
  state               text,
  zip                 text,

  phone               text,
  website             text,

  employee_count      integer,           -- everyone on the payroll
  eligible_count      integer,           -- those eligible for benefits
  fte_count           numeric(8,2),      -- full-time equivalents; fractional on purpose
  -- 50+ FTE is the line that decides the product menu, whether the employer
  -- mandate applies, and whether level-funded and self-funded are available.
  -- Derived so it can never drift from the number it is derived from.
  size_class          text generated always as (
                        case when fte_count is null then null
                             when fte_count >= 50   then 'large'
                             else 'small' end) stored,

  -- The spine of the whole timing system: group business is won 90-120 days
  -- before renewal. renewal_date when we know the day, renewal_month when the
  -- employer only knows the month.
  renewal_date        date,
  renewal_month       smallint check (renewal_month between 1 and 12),
  current_carrier     text,

  primary_agent_id    uuid not null references public.agents(id),
  agency_id           uuid references public.agencies(id),

  -- Verification: created from our research, confirmed by the employer at
  -- census return. Unverified data is a guess and should read as one.
  verified_at         timestamptz,
  verified_source     text,
  verified_by_contact_id uuid references public.contacts(id) on delete set null,

  notes               text,              -- agent-facing only; see the note above

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  created_by_agent_id uuid references public.agents(id),

  -- Normalised name for duplicate detection. Punctuation, case and spacing
  -- only — "ACME Inc" and "ACME LLC" are deliberately NOT merged, because they
  -- can be genuinely different entities.
  name_key            text generated always as (
                        regexp_replace(lower(coalesce(legal_name,'')), '[^a-z0-9]+', '', 'g')
                      ) stored
);

-- One EIN is one employer. A hard rule, and the only one — name+zip is a
-- warning the agent resolves, not a wall, because two franchise locations can
-- share both legitimately.
create unique index if not exists employers_ein_uniq
  on public.employers (ein) where ein is not null;
create index if not exists employers_name_key_zip_idx on public.employers (name_key, zip);
create index if not exists employers_agent_idx        on public.employers (primary_agent_id);
create index if not exists employers_renewal_idx      on public.employers (renewal_month);

-- ── people at the employer, by role ──────────────────────────────────────────
-- A contact is ATTACHED with a role, never converted into one. The person we
-- have talked to for six weeks routinely turns out not to be the decision
-- maker, and we need to keep both.
create table if not exists public.employer_contacts (
  id                  uuid primary key default gen_random_uuid(),
  employer_id         uuid not null references public.employers(id) on delete cascade,
  contact_id          uuid not null references public.contacts(id)  on delete cascade,
  role                text not null check (role in
                        ('decision_maker','benefits_admin','billing','employee','other')),
  title               text,
  is_primary          boolean not null default false,
  created_at          timestamptz not null default now(),
  created_by_agent_id uuid references public.agents(id)
);
-- One person may hold several roles; they may not hold the same one twice.
create unique index if not exists employer_contacts_uniq
  on public.employer_contacts (employer_id, contact_id, role);
-- Exactly one main contact per employer.
create unique index if not exists employer_contacts_one_primary
  on public.employer_contacts (employer_id) where is_primary;
create index if not exists employer_contacts_contact_idx on public.employer_contacts (contact_id);

-- ── worksites ────────────────────────────────────────────────────────────────
create table if not exists public.employer_locations (
  id             uuid primary key default gen_random_uuid(),
  employer_id    uuid not null references public.employers(id) on delete cascade,
  label          text,
  street         text,
  city           text,
  state          text,
  zip            text,
  employee_count integer,
  is_primary     boolean not null default false,
  created_at     timestamptz not null default now()
);
create unique index if not exists employer_locations_one_primary
  on public.employer_locations (employer_id) where is_primary;
create index if not exists employer_locations_employer_idx on public.employer_locations (employer_id);

-- ── the workspace ────────────────────────────────────────────────────────────
-- Created with the employer, empty and dark. It becomes the census page, then
-- the proposal sandbox, then the client portal — one place for the employer's
-- whole life with us rather than a series of one-off links. Nobody outside the
-- agency can reach it until somebody is invited, which happens at the census
-- ask, not here: provisioning logins for prospects who have never spoken to us
-- would be hundreds of accounts of unnecessary security surface.
create table if not exists public.employer_workspaces (
  id            uuid primary key default gen_random_uuid(),
  employer_id   uuid not null unique references public.employers(id) on delete cascade,
  status        text not null default 'dark' check (status in ('dark','active','archived')),
  activated_at  timestamptz,
  archived_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- Created by trigger, not by application code, so "the workspace exists with
-- the employer" cannot be forgotten at one of the call sites.
create or replace function public.employer_workspace_autocreate()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.employer_workspaces (employer_id) values (new.id)
  on conflict (employer_id) do nothing;
  return new;
end $$;

drop trigger if exists on_employer_created on public.employers;
create trigger on_employer_created after insert on public.employers
  for each row execute function public.employer_workspace_autocreate();

-- ── who at the employer may eventually get in ────────────────────────────────
-- Keyed on email because we know it long before they ever sign in — the
-- invitation is written here, and the magic link they click later is matched
-- against it. Access is granted by an explicit row and nothing else: never
-- inferred from an email domain, never from a name match.
create table if not exists public.employer_workspace_members (
  id                  uuid primary key default gen_random_uuid(),
  employer_id         uuid not null references public.employers(id) on delete cascade,
  contact_id          uuid references public.contacts(id) on delete set null,
  email               text not null,
  role                text not null check (role in
                        ('decision_maker','benefits_admin','billing','employee')),
  status              text not null default 'invited'
                        check (status in ('invited','active','revoked')),
  invited_at          timestamptz not null default now(),
  activated_at        timestamptz,
  revoked_at          timestamptz,
  invited_by_agent_id uuid references public.agents(id)
);
create unique index if not exists employer_workspace_members_uniq
  on public.employer_workspace_members (employer_id, lower(email));
create index if not exists employer_workspace_members_email_idx
  on public.employer_workspace_members (lower(email)) where status = 'active';

-- ── the deal's employer ──────────────────────────────────────────────────────
alter table public.deals add column if not exists employer_id uuid
  references public.employers(id) on delete set null;
create index if not exists deals_employer_idx on public.deals (employer_id);

-- ── updated_at ───────────────────────────────────────────────────────────────
create or replace function public.employers_touch_updated_at()
returns trigger language plpgsql
set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists employers_touch on public.employers;
create trigger employers_touch before update on public.employers
  for each row execute function public.employers_touch_updated_at();

-- ── RLS, in the same migration that creates the tables ───────────────────────
alter table public.employers                enable row level security;
alter table public.employer_contacts        enable row level security;
alter table public.employer_locations       enable row level security;
alter table public.employer_workspaces      enable row level security;
alter table public.employer_workspace_members enable row level security;

-- No anonymous access of any kind. These pages do not exist for the public and
-- the anon key is published in the CRM's own source.
revoke all on public.employers                  from anon;
revoke all on public.employer_contacts          from anon;
revoke all on public.employer_locations         from anon;
revoke all on public.employer_workspaces        from anon;
revoke all on public.employer_workspace_members from anon;

grant select, insert, update, delete on public.employers                  to authenticated;
grant select, insert, update, delete on public.employer_contacts          to authenticated;
grant select, insert, update, delete on public.employer_locations         to authenticated;
grant select, insert, update         on public.employer_workspaces        to authenticated;
grant select, insert, update, delete on public.employer_workspace_members to authenticated;

-- is_an_agent() is not redundant next to can_see_agent_work(): the second
-- answers "whose work is this", the first answers "are you staff at all".
-- A signed-in stranger passes neither, but only the first says so plainly.
drop policy if exists "agents manage employers in their book" on public.employers;
create policy "agents manage employers in their book" on public.employers
  for all to authenticated
  using       (is_an_agent() and can_see_agent_work(primary_agent_id))
  with check  (is_an_agent() and can_see_agent_work(primary_agent_id));

drop policy if exists "agents manage employer contacts" on public.employer_contacts;
create policy "agents manage employer contacts" on public.employer_contacts
  for all to authenticated
  using      (is_an_agent() and exists (select 1 from public.employers e
                where e.id = employer_id and can_see_agent_work(e.primary_agent_id)))
  with check (is_an_agent() and exists (select 1 from public.employers e
                where e.id = employer_id and can_see_agent_work(e.primary_agent_id)));

drop policy if exists "agents manage employer locations" on public.employer_locations;
create policy "agents manage employer locations" on public.employer_locations
  for all to authenticated
  using      (is_an_agent() and exists (select 1 from public.employers e
                where e.id = employer_id and can_see_agent_work(e.primary_agent_id)))
  with check (is_an_agent() and exists (select 1 from public.employers e
                where e.id = employer_id and can_see_agent_work(e.primary_agent_id)));

drop policy if exists "agents manage employer workspaces" on public.employer_workspaces;
create policy "agents manage employer workspaces" on public.employer_workspaces
  for all to authenticated
  using      (is_an_agent() and exists (select 1 from public.employers e
                where e.id = employer_id and can_see_agent_work(e.primary_agent_id)))
  with check (is_an_agent() and exists (select 1 from public.employers e
                where e.id = employer_id and can_see_agent_work(e.primary_agent_id)));

drop policy if exists "agents manage workspace members" on public.employer_workspace_members;
create policy "agents manage workspace members" on public.employer_workspace_members
  for all to authenticated
  using      (is_an_agent() and exists (select 1 from public.employers e
                where e.id = employer_id and can_see_agent_work(e.primary_agent_id)))
  with check (is_an_agent() and exists (select 1 from public.employers e
                where e.id = employer_id and can_see_agent_work(e.primary_agent_id)));

-- ── duplicate detection ──────────────────────────────────────────────────────
-- A warning the agent resolves, not a constraint that blocks them. Returns the
-- likely matches so the UI can say "did you mean this one?" before inserting a
-- second copy of a business we already know. Runs as the caller so it can only
-- ever surface employers that caller is already allowed to see.
create or replace function public.find_employer_duplicates(p_name text, p_zip text default null)
returns table (id uuid, legal_name text, dba text, city text, state text, zip text,
               primary_agent_id uuid, match_reason text)
language sql stable security invoker set search_path = public as $$
  select e.id, e.legal_name, e.dba, e.city, e.state, e.zip, e.primary_agent_id,
         case when e.zip is not distinct from p_zip then 'same name and ZIP'
              else 'same name' end
  from public.employers e
  where e.name_key = regexp_replace(lower(coalesce(p_name,'')), '[^a-z0-9]+', '', 'g')
    and coalesce(p_name,'') <> ''
  order by (e.zip is not distinct from p_zip) desc, e.legal_name
  limit 10;
$$;

revoke all on function public.find_employer_duplicates(text, text) from public, anon;
grant execute on function public.find_employer_duplicates(text, text) to authenticated;

-- Trigger functions are never called by hand. Leaving them granted would put
-- names on the anon-executable list that map to no public page, and that list
-- is only useful for spotting holes while every name on it is explainable.
-- (Verified after revoking: both triggers still fire — Postgres does not check
-- EXECUTE on a trigger function for the user performing the insert.)
revoke all on function public.employer_workspace_autocreate() from public, anon, authenticated;
revoke all on function public.employers_touch_updated_at()    from public, anon, authenticated;

comment on table public.employers is
  'Businesses we sell group benefits to. Created at Qualified from agent research, verified at census return by the employer. Not to be confused with public.companies, which is our own two divisions.';
comment on column public.employers.size_class is
  'Derived from fte_count: 50+ FTE is large (employer mandate applies, level-funded and self-funded in scope).';
comment on table public.employer_workspace_members is
  'Who at the employer may reach their workspace. Access is this row and nothing else - never inferred from an email domain. The portal reads employer data through a security definer function, never through the employers table, because row policies cannot restrict columns.';
