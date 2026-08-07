-- Group pipeline stage rename, 2026-08-06.
--
-- Stages now describe the state of the PROSPECT rather than our last action,
-- and the two census states exist so a census sitting unreturned is visible on
-- the board instead of hiding inside whatever stage the card was parked in.
--
--   Researched      -> Qualified
--   Outreach Sent   -> Outreach
--   Responded       -> Engaged
--   Discovery Call  -> Discovery
--   Active Client   -> Enrolled     (group has no Active Client column now —
--                                    the live book is read from enrollments)
--
-- New stages with no old equivalent: Census Requested, Census Received,
-- Marketing. New Lead, Proposal and Enrolled keep their names.
--
-- Only one group deal existed when this was written (a test record at
-- Responded), but the statement is written to cover every old name so a deal
-- created between authoring and deploy is carried across too.

update deals
set    stage = case stage
                 when 'Researched'     then 'Qualified'
                 when 'Outreach Sent'  then 'Outreach'
                 when 'Responded'      then 'Engaged'
                 when 'Discovery Call' then 'Discovery'
                 when 'Active Client'  then 'Enrolled'
                 else stage
               end
where  pipeline = 'group-employer'
  and  stage in ('Researched','Outreach Sent','Responded','Discovery Call','Active Client');

-- Leaves other pipelines untouched: 'Contacted' and 'Active Client' are real
-- Individual & Family stages and must keep their meaning there.
