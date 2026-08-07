-- Phase 3: the board moves itself, 2026-08-06.
--
-- The signals already existed and touched nothing. The email engine detected a
-- reply and flagged a Hot Lead; a prospect booked a call; an employer returned a
-- census — and in every case the deal sat exactly where it was, waiting for a
-- human to drag it. Now it moves.
--
-- These have to fire at 2am with nobody logged in, so they live in the database
-- rather than in crm.js. Which means the stage list has to exist here too — and
-- a second copy of a list is how Phase 1's bug happened. So the stages become a
-- TABLE that is the single source of truth, with tools/check-pipeline-parity.js
-- holding crm.js to it, the same way check-intake-parity.js keeps the two intake
-- catalogues honest.

create table if not exists public.pipeline_stages (
  pipeline   text    not null,
  stage      text    not null,
  sort_order integer not null,
  primary key (pipeline, stage),
  unique (pipeline, sort_order)
);

-- A level (how warm a lead is) points at a stage OF THAT PIPELINE, and the
-- foreign key is the entire point: it is now structurally impossible to aim an
-- entry level at a stage the pipeline does not have. That is exactly what put
-- referred employers on 'Contacted', an Individual & Family stage, where the
-- group board had no column to draw them in and the deals rendered nowhere.
create table if not exists public.pipeline_entry_stages (
  pipeline text not null,
  level    text not null check (level in ('cold','warm','outreach','engaged','booked')),
  stage    text not null,
  primary key (pipeline, level),
  foreign key (pipeline, stage) references public.pipeline_stages (pipeline, stage)
    on update cascade on delete cascade
);

truncate public.pipeline_entry_stages;
delete from public.pipeline_stages;

insert into public.pipeline_stages (pipeline, stage, sort_order) values
  ('group-employer','New Lead',0), ('group-employer','Qualified',1),
  ('group-employer','Outreach',2), ('group-employer','Engaged',3),
  ('group-employer','Discovery',4), ('group-employer','Census Requested',5),
  ('group-employer','Census Received',6), ('group-employer','Marketing',7),
  ('group-employer','Proposal',8), ('group-employer','Enrolled',9),

  ('individual-family','New Lead',0), ('individual-family','Contacted',1),
  ('individual-family','Needs Assessment',2), ('individual-family','Quoted',3),
  ('individual-family','Application',4), ('individual-family','Enrolled',5),
  ('individual-family','Active Client',6),

  ('medicare','Inquiry',0), ('medicare','Intake Complete',1),
  ('medicare','SOA Signed',2), ('medicare','Needs Analysis',3),
  ('medicare','Plan Comparison',4), ('medicare','Application Submitted',5),
  ('medicare','Enrolled',6), ('medicare','Annual Review',7),

  ('agent-insured','Identified',0), ('agent-insured','Contacted',1),
  ('agent-insured','Applied',2), ('agent-insured','Interested',3),
  ('agent-insured','Interview',4), ('agent-insured','Licensing Support',5),
  ('agent-insured','Contracted',6), ('agent-insured','Active Agent',7),

  ('agent-kannon','Identified',0), ('agent-kannon','Contacted',1),
  ('agent-kannon','Applied',2), ('agent-kannon','Interested',3),
  ('agent-kannon','Interview',4), ('agent-kannon','Licensing Support',5),
  ('agent-kannon','Contracted',6), ('agent-kannon','Active Agent',7);

insert into public.pipeline_entry_stages (pipeline, level, stage) values
  ('group-employer','cold','New Lead'),   ('group-employer','warm','New Lead'),
  ('group-employer','outreach','Outreach'),('group-employer','engaged','Engaged'),
  ('group-employer','booked','Discovery'),

  ('individual-family','cold','New Lead'), ('individual-family','warm','Contacted'),
  ('individual-family','outreach','Contacted'),('individual-family','engaged','Contacted'),
  ('individual-family','booked','Contacted'),

  ('medicare','cold','Inquiry'), ('medicare','warm','Inquiry'),
  ('medicare','outreach','Inquiry'), ('medicare','engaged','Inquiry'),
  ('medicare','booked','Inquiry'),

  ('agent-insured','cold','Identified'), ('agent-insured','warm','Contacted'),
  ('agent-insured','outreach','Contacted'),('agent-insured','engaged','Interested'),
  ('agent-insured','booked','Interview'),

  ('agent-kannon','cold','Identified'), ('agent-kannon','warm','Contacted'),
  ('agent-kannon','outreach','Contacted'),('agent-kannon','engaged','Interested'),
  ('agent-kannon','booked','Interview');

alter table public.pipeline_stages       enable row level security;
alter table public.pipeline_entry_stages enable row level security;
revoke all on public.pipeline_stages       from anon;
revoke all on public.pipeline_entry_stages from anon;
grant select on public.pipeline_stages       to authenticated;
grant select on public.pipeline_entry_stages to authenticated;

drop policy if exists "agents read pipeline stages" on public.pipeline_stages;
create policy "agents read pipeline stages" on public.pipeline_stages
  for select to authenticated using (is_an_agent());
drop policy if exists "agents read entry stages" on public.pipeline_entry_stages;
create policy "agents read entry stages" on public.pipeline_entry_stages
  for select to authenticated using (is_an_agent());

-- ── the one way a deal advances by itself ────────────────────────────────────
-- FORWARD ONLY. An Enrolled client who replies to an email is not dragged back
-- to Engaged, and a closed deal is left alone entirely — reopening one is a
-- decision a person makes, never a side effect of an inbound email.
--
-- SECURITY DEFINER because the callers include triggers on rows written by anon
-- (a prospect booking a call from book.html) and by the service key (the Apps
-- Script inbox processor), neither of which may touch `deals` directly. EXECUTE
-- is revoked from everyone: these are reachable only through their triggers.
--
-- Known and accepted: anon may insert booking_intents — that is a documented
-- public write, it is how the booking page works — so an anon insert can move a
-- card. The blast radius is a card on a board, not data, and the exposure to
-- create the booking in the first place already existed.
create or replace function public.advance_deal_to(
  p_deal_id uuid, p_stage text, p_reason text, p_source text default 'system')
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_deal        deals%rowtype;
  v_current_idx integer;
  v_target_idx  integer;
begin
  select * into v_deal from deals where id = p_deal_id;
  if not found or v_deal.closed_at is not null then return false; end if;

  select sort_order into v_target_idx  from pipeline_stages
   where pipeline = v_deal.pipeline and stage = p_stage;
  -- The stage does not exist in this deal's pipeline — 'Census Received' on an
  -- Individual & Family deal, say. Do nothing rather than invent a stage.
  if v_target_idx is null then return false; end if;

  select sort_order into v_current_idx from pipeline_stages
   where pipeline = v_deal.pipeline and stage = v_deal.stage;
  if v_current_idx is not null and v_current_idx >= v_target_idx then return false; end if;

  update deals set stage = p_stage where id = p_deal_id;

  -- Pre-marked read: this is the trail explaining why a card moved, not an
  -- alert. The signals that deserve attention already raise their own.
  insert into activities (contact_id, agent_id, activity_type, subject, body_snippet,
                          metadata, source, read_at)
  values (v_deal.contact_id, v_deal.agent_id, 'deal_stage_auto',
          'Moved to ' || p_stage, p_reason,
          jsonb_build_object('deal_id', p_deal_id, 'from', v_deal.stage, 'to', p_stage),
          p_source, now());
  return true;
end $$;

revoke all on function public.advance_deal_to(uuid, text, text, text) from public, anon, authenticated;

-- Advance every open deal a contact has. A reply is a signal about the PERSON,
-- not about one opportunity, and forward-only stops it doing anything silly.
create or replace function public.advance_contact_deals(
  p_contact_id uuid, p_level text, p_reason text, p_source text default 'system')
returns integer
language plpgsql security definer set search_path = public as $$
declare v_deal record; v_stage text; v_moved integer := 0;
begin
  for v_deal in select d.id, d.pipeline from deals d
                 where d.contact_id = p_contact_id and d.closed_at is null loop
    select stage into v_stage from pipeline_entry_stages
     where pipeline = v_deal.pipeline and level = p_level;
    if v_stage is not null and advance_deal_to(v_deal.id, v_stage, p_reason, p_source) then
      v_moved := v_moved + 1;
    end if;
  end loop;
  return v_moved;
end $$;

revoke all on function public.advance_contact_deals(uuid, text, text, text) from public, anon, authenticated;

-- ── 1. they replied ──────────────────────────────────────────────────────────
-- The WHEN clause matters: Apps Script updates contacts constantly (sequence
-- step, last_email_sent_at), and this must fire on a reply and nothing else.
create or replace function public.on_contact_replied()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform advance_contact_deals(new.id, 'engaged',
            'They replied — the board moved itself.', 'email');
  return new;
end $$;

drop trigger if exists contact_replied_advances_deal on public.contacts;
create trigger contact_replied_advances_deal
  after update on public.contacts
  for each row
  when ((new.last_replied_at is distinct from old.last_replied_at and new.last_replied_at is not null)
     or (new.sequence_status = 'Replied' and old.sequence_status is distinct from 'Replied'))
  execute function public.on_contact_replied();

-- ── 2. they booked ───────────────────────────────────────────────────────────
create or replace function public.on_booking_advances_deal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.contact_id is not null and coalesce(new.status,'') <> 'cancelled' then
    perform advance_contact_deals(new.contact_id, 'booked',
              'They booked a meeting — the board moved itself.', 'booking');
  end if;
  return new;
end $$;

drop trigger if exists booking_advances_deal on public.booking_intents;
create trigger booking_advances_deal
  after insert on public.booking_intents
  for each row execute function public.on_booking_advances_deal();

-- ── 3. the census went out, and 4. it came back ──────────────────────────────
create or replace function public.on_census_advances_deal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.deal_id is null then return new; end if;

  if tg_op = 'INSERT' then
    perform advance_deal_to(new.deal_id, 'Census Requested',
              'Census requested — waiting on the employer.', 'census');

  elsif new.status = 'submitted' and old.status is distinct from 'submitted' then
    -- The strongest buying signal in the whole group process: they signed a
    -- HIPAA agreement and handed over their employees' dates of birth.
    perform advance_deal_to(new.deal_id, 'Census Received',
              'Census returned by the employer.', 'census');
  end if;
  return new;
end $$;

drop trigger if exists census_advances_deal_ins on public.census_requests;
create trigger census_advances_deal_ins after insert on public.census_requests
  for each row execute function public.on_census_advances_deal();

drop trigger if exists census_advances_deal_upd on public.census_requests;
create trigger census_advances_deal_upd after update on public.census_requests
  for each row execute function public.on_census_advances_deal();

comment on table public.pipeline_stages is
  'Single source of truth for pipeline stages and their order. crm.js PIPELINES must match; tools/check-pipeline-parity.js enforces it.';
comment on function public.advance_deal_to(uuid, text, text, text) is
  'Forward-only stage advance. Never moves a closed deal, never moves backward, does nothing if the stage does not belong to that deal pipeline.';

-- VERIFIED with a throwaway group deal and a throwaway I&F deal, all 8 PASS:
--   reply -> Engaged; booking -> Discovery; census sent -> Census Requested;
--   census back -> Census Received; a LATER reply does NOT drag it back; a
--   closed deal is untouched; 'Census Received' on an I&F deal is a no-op
--   rather than an invented stage; an I&F reply lands on 'Contacted', that
--   pipeline's own word for the same thing. Fixtures deleted afterwards.
