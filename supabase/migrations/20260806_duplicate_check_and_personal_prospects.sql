-- Applied to production 2026-08-06.
--
-- Two changes, both from Ken:
--   1. Stop duplicate contacts getting into the book.
--   2. The public card form should not make a stranger file themselves into
--      a category. It takes a note instead; the agent categorises later from
--      the Personal Prospect chip on their dashboard.

-- ---------------------------------------------------------------------------
-- 1. contact_duplicate_check — used by the agent app on scan and on manual entry.
--
-- Scoped to the caller's own office(s). Insured America Agency and Kannon Krew
-- are separate books, so a prospect sitting in the other one is not this
-- agent's business and is not reported.
--
-- Deliberately narrow, so it cannot be turned into a way to browse a
-- colleague's book:
--   * exact email or exact last-10-digits phone only. No wildcards, no partial
--     matching -- you must already know the person to get a hit.
--   * at most one row back.
--   * a colleague's match returns the contact's name and the owning agent's
--     name and NOTHING else. No id, no email, no phone. The contact id comes
--     back only when the row is the caller's own, which they can open anyway.
--
-- That is the same information the agent would get by trying to add the
-- contact and being told it is taken, which is the whole point of the feature.
--
-- Verified by probe 2026-08-06: exact email (any casing), phone with
-- punctuation, and phone with a +1 country code all match; partial email,
-- 7-digit phone and a '%' wildcard all return nothing; an agent in a different
-- office sees nothing; a colleague match returns names with a null contact_id;
-- anon gets 401.

create or replace function public.contact_duplicate_check(
  p_email text default null,
  p_phone text default null
)
returns table (
  match_type   text,   -- 'mine' | 'colleague'
  contact_id   uuid,   -- only populated for 'mine'
  contact_name text,
  owner_name   text,
  matched_on   text    -- 'email' | 'phone'
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_me     public.agents%rowtype;
  v_email  text := nullif(lower(btrim(p_email)), '');
  v_digits text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
begin
  select * into v_me
  from public.agents a
  where a.email = (select auth.jwt() ->> 'email')
  limit 1;
  if not found then
    return;
  end if;

  if v_digits is not null and length(v_digits) >= 10 then
    v_digits := right(v_digits, 10);
  else
    v_digits := null;
  end if;
  if v_email is null and v_digits is null then
    return;
  end if;

  return query
  select
    case when c.agent_id = v_me.id then 'mine' else 'colleague' end,
    case when c.agent_id = v_me.id then c.id else null end,
    c.name,
    coalesce(o.display_name, o.name),
    case
      when v_email is not null and lower(c.email) = v_email then 'email'
      else 'phone'
    end
  from public.contacts c
  left join public.agents o on o.id = c.agent_id
  where (
          (v_email is not null and lower(c.email) = v_email)
       or (v_digits is not null
           and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = v_digits)
        )
    and (
          c.agent_id = v_me.id
       or o.agency_id in (
            select aa.agency_id from public.agent_agencies aa where aa.agent_id = v_me.id
            union
            select v_me.agency_id where v_me.agency_id is not null
          )
        )
  order by (c.agent_id = v_me.id) desc, c.created_at
  limit 1;
end;
$function$;

revoke all on function public.contact_duplicate_check(text, text) from public, anon;
grant execute on function public.contact_duplicate_check(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. capture_card_lead — category now optional, and de-duplicates.
--
-- p_type defaults to null: the contact arrives uncategorised and shows on the
-- agent's Personal Prospect chip until they file it.
--
-- De-duplication is silent by design. The public form must never reveal
-- whether a given email is already in the CRM, so a repeat submission simply
-- appends its note to the existing record and returns that same id. Blank
-- fields are filled in from the new submission; nothing already present is
-- ever overwritten.

create or replace function public.capture_card_lead(
  p_agent_id uuid,
  p_name     text,
  p_email    text default null,
  p_phone    text default null,
  p_notes    text default null,
  p_type     text default null,
  p_ip_hash  text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id       uuid;
  v_agency   uuid;
  v_existing uuid;
  v_name     text := nullif(btrim(p_name), '');
  v_email    text := nullif(lower(btrim(p_email)), '');
  v_phone    text := nullif(btrim(p_phone), '');
  v_digits   text;
  v_recent   integer;
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

  v_digits := nullif(regexp_replace(coalesce(v_phone, ''), '[^0-9]', '', 'g'), '');
  if v_phone is not null and length(v_digits) < 10 then
    raise exception 'invalid phone' using errcode = '22023';
  end if;
  if v_digits is not null then
    v_digits := right(v_digits, 10);
  end if;

  if p_type is not null and p_type not in
     ('Individual/Family', 'Group/Employer',
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

  select c.id into v_existing
  from public.contacts c
  where c.agent_id = p_agent_id
    and (
          (v_email is not null and lower(c.email) = v_email)
       or (v_digits is not null
           and right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = v_digits)
        )
  order by c.created_at
  limit 1;

  if found then
    update public.contacts c set
      email      = coalesce(c.email, v_email),
      phone      = coalesce(c.phone, v_phone),
      notes      = left(
                     concat_ws(E'\n', nullif(c.notes, ''), nullif(btrim(coalesce(p_notes, '')), '')),
                     4000),
      updated_at = now()
    where c.id = v_existing;
    return v_existing;
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
