-- Two things from Ken, and the second found a gap.
--
-- 1. WHAT GOES TO A CARRIER. "we don't need to send the contributions and the
--    classes. just the basic employer group information and the list of
--    employees and dependents."
--
--    He is right, and it is more than a preference. Contribution strategy and
--    the eligibility classes an employer has drawn are how that employer
--    intends to BUY — the very thing the sandbox exists to let them model. It
--    is commercially theirs, it is not underwriting data, and it should not be
--    sitting in a carrier's inbox before a proposal is even written.
--
--    So the default template below carries the employer block and the roster,
--    and nothing else. employee_class and everything in employer_contributions
--    are excluded by construction rather than by remembering to leave them out.
--
--    hours_per_week IS included: carriers use it to verify who is genuinely
--    full-time, and it describes the employee rather than the employer's offer.
--    Flagged to Ken so he can say if it should go too.
--
--    (Separate from the census, for the RFP cover: carriers usually do ask for
--    the employer's contribution PERCENTAGE, because participation minimums
--    depend on it. That is one summary figure on the request, not the per-class
--    tables — and whether it appears at all is Ken's call.)
--
-- 2. WHO IS ASKING. "the carrier that an agent sends to also should put the
--    agent on the request as well as their contact information."
--
--    marketing_submissions recorded which carrier and which round, but never
--    who sent it. marketing_rounds.opened_by is not the same person — one agent
--    can open a round and another can market it, and different carriers in one
--    round can be handled by different agents. So the sender is recorded per
--    submission, and that is who the carrier sees and replies to.
--
--    At send time the request carries that agent's name, email and phone, and
--    their writing number for THAT carrier from carrier_appointments — which is
--    the first thing a carrier's new-business desk asks for.

alter table marketing_submissions
  add column if not exists sent_by uuid references agents(id);

comment on column marketing_submissions.sent_by is
  'The agent who actually sent THIS submission — named on the request so the carrier knows who is asking. Not necessarily marketing_rounds.opened_by.';


-- Our fallback layout, used for every carrier who never supplied a template.
-- Columns are ordered as a person reads a census: who they are, then the facts
-- a carrier rates on. `field` names map to census_employees, and the export
-- resolves them from the FROZEN census revision.
--
-- ssn is deliberately absent. When a carrier is opted in it is appended, so the
-- default layout can never leak one by being reused carelessly.
insert into carrier_census_templates
  (carrier_id, name, is_default, file_format, includes_ssn, columns, notes)
select null,
       'Insured America standard census',
       true,
       'xlsx',
       false,
       '[{"header":"Employee #",    "field":"employee_number"},
         {"header":"Name",          "field":"full_name"},
         {"header":"Relationship",  "field":"relationship"},
         {"header":"Date of Birth", "field":"date_of_birth", "format":"MM/DD/YYYY"},
         {"header":"Gender",        "field":"gender"},
         {"header":"ZIP",           "field":"zip"},
         {"header":"Hours / Week",  "field":"hours_per_week"}]'::jsonb,
       'Employer block plus the roster. No contributions and no eligibility classes — Ken, 2026-08-08: that is how the employer intends to buy, not what a carrier rates on.'
where not exists (
  select 1 from carrier_census_templates where is_default and carrier_id is null);
