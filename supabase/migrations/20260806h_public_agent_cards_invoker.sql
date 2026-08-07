-- public_agent_cards: stop bypassing row security, 2026-08-06.
--
-- THE PROBLEM. The view ran as its owner, so it skipped RLS on `agents`
-- entirely. Nothing was leaking — the column list was explicit and the WHERE
-- clause correct — but that one hand-written predicate was the only thing
-- between the published anon key and every agent row, including
-- gmail_refresh_token, workspace emails and NIPR results. One careless edit to
-- the view would have published all of it. It also sat as a permanent ERROR on
-- the advisor list, which is its own hazard: a standing red mark is where the
-- next real finding goes to hide.
--
-- THE FIX. Not one field of exposed data changes. What changes is WHO enforces
-- it — Postgres row security plus column-level grants, two independent layers,
-- rather than a predicate inside a view.
--
-- ANON ONLY, and this is the important part. `authenticated` holds a
-- full-table SELECT grant on agents, so giving that role the same policy would
-- hand every column of every public-profile agent to any signed-in stranger.
-- Signup is open by design, so "authenticated" is not a trust level.

-- The 15 published card columns...
grant select (
  id, slug, name, display_name, title, bio, brand, specialties, licensed_states,
  headshot_url, has_life_license, has_health_license, has_investment_license,
  card_phone, card_email
) on public.agents to anon;

-- ...plus the two the view's own WHERE clause reads. Under security_invoker the
-- CALLER needs SELECT on every column the view touches, not merely the ones it
-- returns. Missing these produced 42501 and took the public team pages blank —
-- caught by probing the live endpoint, which is the whole argument for probing
-- rather than reasoning about it.
--
-- They add no exposure: the policy below already restricts anon to rows where
-- status='active' and public_profile is true, so reading those columns can only
-- ever return 'active' and true, and filtering on them cannot reveal a hidden
-- agent because the policy removes those rows first. Both verified by request.
grant select (status, public_profile) on public.agents to anon;

drop policy if exists public_agent_cards_readable_by_anon on public.agents;
create policy public_agent_cards_readable_by_anon on public.agents
  for select to anon
  using (status = 'active' and public_profile = true and slug is not null);

alter view public.public_agent_cards set (security_invoker = true);

-- VERIFIED BY REQUEST, not by reading policy:
--   /about roster, /team/<slug> and the card scanner all return 200 with data
--   select=email / gmail_refresh_token / auth_user_id / *   -> 42501 refused
--   ?public_profile=eq.false and ?status=neq.active         -> empty
--   anon PATCH of an agent                                  -> 42501 refused
--   Ken still reads all 4 agents; a plain agent still reads only their own
--   office — the login path is untouched.
--   get_advisors(security) afterwards: 0 CRITICAL, 0 ERROR.
--
-- KNOCK-ON, fixed in the website repo in the same change: the view now runs as
-- the caller, so a SIGNED-IN agent reads it under their own office scoping.
-- ContactApp looked cards up with the session client, which would have quietly
-- returned nothing when an agent scanned a colleague's card from another
-- office. It now calls fetchAgentBySlug, which uses the anon key — a published
-- card is public by definition, so the answer must not depend on who asks.
