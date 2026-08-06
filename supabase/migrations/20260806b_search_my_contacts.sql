-- Applied to production 2026-08-06.
--
-- Search behind the agent app's Contacts tab (formerly "Recent"): by name,
-- email or phone, with an optional category filter.
--
-- SECURITY INVOKER on purpose. The existing row-level policy on contacts
-- already decides what each agent may see -- their own rows, plus their office
-- if they are an owner -- so this inherits that rather than reimplementing it.
-- A second copy of a security rule is a second thing to keep in step.
--
-- Phone matching compares digits to digits. The same number lives in this CRM
-- as "4064910982" and as "406-555-0177", so a plain text search finds one and
-- misses the other. Stripping both sides means an agent can type the number
-- however they like and still find it.
--
-- Verified by probe 2026-08-06 as Ken: the same contact is found by
-- "4066004562", "(406) 600-4562", "406-600-4562" and the partial "6004562";
-- name search works; the individual filter returns exactly the 60 rows the
-- table holds; a nonsense term returns none; anon gets 401.

create or replace function public.search_my_contacts(
  p_q     text    default null,
  p_type  text    default null,   -- 'individual' | 'group' | 'recruiting' | null for all
  p_limit integer default 50
)
returns table (
  id         uuid,
  name       text,
  type       text,
  email      text,
  phone      text,
  created_at timestamptz
)
language sql
stable
security invoker
set search_path to 'public'
as $function$
  with q as (
    select
      nullif(btrim(coalesce(p_q, '')), '')                              as term,
      nullif(regexp_replace(coalesce(p_q, ''), '[^0-9]', '', 'g'), '')  as digits
  )
  select c.id, c.name, c.type, c.email, c.phone, c.created_at
  from public.contacts c, q
  where (
          q.term is null
       or c.name  ilike '%' || q.term || '%'
       or c.email ilike '%' || q.term || '%'
          -- Only a phone search once enough digits are typed to mean
          -- something; two digits would match half the book.
       or (q.digits is not null and length(q.digits) >= 3
           and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g')
               like '%' || q.digits || '%')
        )
    and (
          p_type is null
       or (p_type = 'individual' and c.type = 'Individual/Family')
       or (p_type = 'group'      and c.type = 'Group/Employer')
          -- One "recruiting" bucket covers both companies' agent types: an
          -- agent looking for their recruits is not thinking about which
          -- brand the record was filed under.
       or (p_type = 'recruiting' and c.type in ('Agent — Kannon Financial',
                                                'Agent — Insured America'))
        )
  order by c.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$function$;

revoke all on function public.search_my_contacts(text, text, integer) from public, anon;
grant execute on function public.search_my_contacts(text, text, integer) to authenticated;
