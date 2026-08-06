-- Applied to production 2026-08-05.
--
-- Scan-back capture for the digital business cards: someone scans an agent's
-- QR code, lands on /team/<slug>, and sends their own details back. Also adds
-- the opt-in card_phone / card_email fields the card publishes.
--
-- Deliberately NOT capture_web_lead. That function validates nothing,
-- throttles nothing, and silently discards its p_source argument -- it accepts
-- p_source but never writes contacts.lead_source, so every lead captured
-- through it has a null source. Worth fixing separately; the website's contact
-- forms still use it.
--
-- Everything here is checked inside one SECURITY DEFINER function so anon
-- needs EXECUTE on it and no table privileges at all. anon can neither read
-- nor poison card_lead_throttle, and still cannot read contacts.
--
-- Verified by probe 2026-08-05: unknown agent, missing name, missing
-- email+phone, malformed email, junk phone and forged contact type are all
-- rejected; the 6th submission from one IP inside an hour is refused; anon
-- gets 401 on both card_lead_throttle and contacts.

alter table public.agents add column if not exists card_phone text;
alter table public.agents add column if not exists card_email text;

comment on column public.agents.card_phone is
  'Opt-in phone shown on the public business card. Empty by default. Never populate from agents.phone in bulk.';
comment on column public.agents.card_email is
  'Opt-in email shown on the public business card. Empty by default. Never populate from agents.email in bulk.';

create or replace view public.public_agent_cards
with (security_barrier = true) as
select
  a.id, a.slug, a.name, a.display_name, a.title, a.bio, a.brand,
  a.specialties, a.licensed_states, a.headshot_url,
  a.has_life_license, a.has_health_license, a.has_investment_license,
  a.card_phone, a.card_email
from public.agents a
where a.status = 'active'
  and a.public_profile = true
  and a.slug is not null;

revoke all on public.public_agent_cards from anon, authenticated;
grant select on public.public_agent_cards to anon, authenticated;

create table if not exists public.card_lead_throttle (
  id bigserial primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists card_lead_throttle_lookup
  on public.card_lead_throttle (ip_hash, created_at desc);

alter table public.card_lead_throttle enable row level security;
-- No policies and no grants: only the definer function below touches it.

create or replace function public.capture_card_lead(
  p_agent_id uuid,
  p_name     text,
  p_email    text default null,
  p_phone    text default null,
  p_notes    text default null,
  p_type     text default 'Individual/Family',
  p_ip_hash  text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id     uuid;
  v_agency uuid;
  v_name   text := nullif(btrim(p_name), '');
  v_email  text := nullif(lower(btrim(p_email)), '');
  v_phone  text := nullif(btrim(p_phone), '');
  v_recent integer;
begin
  select a.agency_id into v_agency
  from public.agents a
  where a.id = p_agent_id
    and a.status = 'active'
    and a.public_profile = true
    and a.slug is not null;

  if not found then
    raise exception 'unknown agent' using errcode = '22023';
  end if;

  if v_name is null or length(v_name) > 120 then
    raise exception 'name required' using errcode = '22023';
  end if;

  if v_email is null and v_phone is null then
    raise exception 'email or phone required' using errcode = '22023';
  end if;

  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$' then
    raise exception 'invalid email' using errcode = '22023';
  end if;

  if v_phone is not null and length(regexp_replace(v_phone, '[^0-9]', '', 'g')) < 10 then
    raise exception 'invalid phone' using errcode = '22023';
  end if;

  if p_type not in ('Individual/Family', 'Group/Employer',
                    'Agent — Kannon Financial', 'Agent — Insured America') then
    raise exception 'invalid type' using errcode = '22023';
  end if;

  if p_ip_hash is not null then
    select count(*) into v_recent
    from public.card_lead_throttle t
    where t.ip_hash = p_ip_hash
      and t.created_at > now() - interval '1 hour';

    if v_recent >= 5 then
      raise exception 'rate limited' using errcode = '53400';
    end if;

    insert into public.card_lead_throttle (ip_hash) values (p_ip_hash);
  end if;

  insert into public.contacts (
    name, email, phone, type, notes, agent_id, agency_id,
    lead_source, sequence_status, email_status, opt_out_email, created_at
  ) values (
    v_name, v_email, v_phone, p_type, left(coalesce(p_notes, ''), 2000),
    p_agent_id, v_agency,
    'card-scan', 'not started', 'valid', false, now()
  )
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.capture_card_lead(uuid, text, text, text, text, text, text) from public;
grant execute on function public.capture_card_lead(uuid, text, text, text, text, text, text) to anon, authenticated;
