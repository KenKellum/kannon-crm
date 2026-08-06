-- Applied to production 2026-08-05.
--
-- Public, read-only window onto the agents table, for the website's team
-- pages (/team/<slug>), the find-an-agent directory on /about, and the
-- agent digital business cards.
--
-- Why this exists: the website has always queried the agents table with the
-- anon key, but anon was never granted anything on it, so every team page
-- 404'd and the agent directory read "No agents match that filter yet"
-- from launch until now. The fetch helper swallowed the 401, so a broken
-- roster and an empty roster looked identical.
--
-- Do NOT "fix" this by granting anon on public.agents, which is what the
-- Postgres error hint suggests. That table holds gmail_refresh_token,
-- workspace_email, nipr_result, notes and recruited_by. To publish one
-- more field, add that single column to this view instead.
--
-- security_barrier stops a caller-supplied filter function from being
-- pushed down below the WHERE clause to sniff out non-public rows.

create or replace view public.public_agent_cards
with (security_barrier = true) as
select
  a.id,
  a.slug,
  a.name,
  a.display_name,
  a.title,
  a.bio,
  a.brand,
  a.specialties,
  a.licensed_states,
  a.headshot_url,
  a.has_life_license,
  a.has_health_license,
  a.has_investment_license
from public.agents a
where a.status = 'active'
  and a.public_profile = true
  and a.slug is not null;

comment on view public.public_agent_cards is
  'Public-safe slice of agents for thekannongroup.com team pages and agent business cards. Read-only, anon-readable. Do not add sensitive columns.';

revoke all on public.public_agent_cards from anon, authenticated;
grant select on public.public_agent_cards to anon, authenticated;
