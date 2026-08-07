-- Being signed in is not a permission. Being an agent is. 2026-08-06.
--
-- Blocking prerequisite for Phase 5, and the reason it lands first: the
-- workspace is about to hand a real login to every employer contact. Those
-- accounts get the `authenticated` role — and 27 tables were trusting that role
-- blindly with `using (true)`.
--
-- Signup is open by design (people apply, a Broker Owner approves), so
-- `authenticated` has ALWAYS included complete strangers and this was already a
-- latent hole. Phase 5 would have turned it into a likely one. Fixing it after
-- issuing the logins would have been exactly the retrofit pattern that is
-- banned here.
--
-- What a client login could otherwise have read:
--   carrier_appointments  our agents' writing numbers
--   rate_charts/rate_rows our negotiated rate grids
--   carriers, carrier_products, product_documents, extraction_runs
--                         the product catalogue and uploaded rate sheets
--   agencies, agent_agencies, agent_companies, companies, agency_companies,
--   carrier_companies, contact_companies, system_reviews, cms_imports
--                         the internal shape of the business
--
-- DELIBERATELY LEFT OPEN, and not an oversight:
--   cms_plans, pdp_formulary, pdp_plan_formulary, pdp_tier_cost, nadac_price,
--   rxcui_ndc, zip_places, plan_year_config — published government reference
--     data, no commercial or personal content
--   baa_versions, privacy_notice_versions — granted to {public} on purpose;
--     they are served to people who are not signed in at all

do $$
declare
  t text;
  tables text[] := array[
    'agencies','agency_companies','agent_agencies','agent_companies','companies',
    'contact_companies','carrier_appointments','carrier_companies','carrier_products',
    'carriers','rate_charts','rate_rows','product_documents','extraction_runs',
    'system_reviews','cms_imports'
  ];
  p record;
begin
  foreach t in array tables loop
    for p in select policyname from pg_policies
              where schemaname='public' and tablename=t and cmd in ('SELECT','ALL')
                and roles::text like '%authenticated%'
                and (qual is null or btrim(lower(qual)) in ('true','(true)'))
    loop
      execute format('drop policy %I on public.%I', p.policyname, t);
      execute format(
        'create policy %I on public.%I for select to authenticated using (is_an_agent())',
        p.policyname, t);
    end loop;
  end loop;
end $$;

-- VERIFIED by role simulation, three identities:
--   a stranger holding an account  -> 0 rows on every one of them
--   Ken (system_owner)             -> 7 appointments, 5 carriers, 10 products,
--                                     3 agencies, 4 seats, 3 documents, 2 companies
--   a plain agent (not an owner)   -> 5 carriers, 10 products, 3 agencies
--                                     — the CRM is unaffected for real staff
--   zip_places still readable (42,366) — reference data left open on purpose.
