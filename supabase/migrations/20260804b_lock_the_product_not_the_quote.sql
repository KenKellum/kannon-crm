-- THE LOCK BELONGS ON THE PRODUCT, NOT THE QUOTE.
-- Applied to project ilrylhseqnllmejebozq on 2026-08-04, superseding the
-- whole-quote lock in 20260804_enrollment_engine.sql the same day.
--
-- Ken described the job: the agent pulls up the quote, enrols products ONE AT A
-- TIME as the client decides, may add a product the client asks about there and
-- then, and either closes the quote or leaves it open to come back to.
--
-- The first version locked the entire quote on the first enrollment, which
-- forbids exactly that. Now:
--   * enrolling or waiving a product freezes THAT product's numbers — it is the
--     proof of what the client agreed to;
--   * the rest of the quote stays workable, re-priceable, and open to new
--     products;
--   * the quote locks entirely only when the agent CLOSES it, which also waives
--     everything still undecided.
--
-- This is a stronger audit trail, not a weaker one: each option carries its own
-- frozen numbers AND the moment it was decided, instead of one blurry snapshot.

-- When an option was put on the quote, so a product added at enrollment time is
-- visibly later than the ones the client was originally shown.
alter table public.quote_options
  add column if not exists created_at timestamptz not null default now();

update public.quote_options o
   set created_at = q.created_at
  from public.quotes q
 where q.id = o.quote_id and o.created_at > q.created_at;

-- A product is frozen once it has an outcome. Correcting the DECISION stays
-- possible (enrolled in error, waived by mistake); the money and the plan do
-- not move again.
create or replace function public.refuse_to_edit_a_locked_quote_option()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare quote_locked boolean;
begin
  select q.locked_at is not null into quote_locked
    from quotes q where q.id = coalesce(new.quote_id, old.quote_id);
  quote_locked := coalesce(quote_locked, false);

  if tg_op = 'INSERT' then
    -- Adding a product to an OPEN quote is normal, and is the point of this
    -- change. Adding one to a closed quote is not.
    if quote_locked then
      raise exception
        'That quote is closed — a product cannot be added to it. Start a new quote instead.'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.outcome is not null then
      raise exception
        'Option "%" was % on this quote and is part of the record. It cannot be deleted.',
        coalesce(old.display_name, old.id::text), old.outcome
        using errcode = 'restrict_violation';
    end if;
    if quote_locked then
      raise exception
        'That quote is closed and records what was offered. Its options cannot be deleted.'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if old.outcome is null and not quote_locked then return new; end if;

  if (new.carrier_name, new.display_name, new.monthly_premium, new.benefit_bullets,
      new.plan_meta, new.line, new.carrier_id, new.product_id, new.quote_id, new.created_at)
     is distinct from
     (old.carrier_name, old.display_name, old.monthly_premium, old.benefit_bullets,
      old.plan_meta, old.line, old.carrier_id, old.product_id, old.quote_id, old.created_at) then
    raise exception
      'Option "%" has been decided and cannot be changed. Add a new product, or re-quote.',
      coalesce(old.display_name, old.id::text) using errcode = 'restrict_violation';
  end if;
  return new;
end $fn$;

revoke execute on function public.refuse_to_edit_a_locked_quote_option() from anon, authenticated, public;

-- The quote-level guard now only has to protect a CLOSED quote.
create or replace function public.refuse_to_edit_a_locked_quote()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
  if old.locked_at is null then return new; end if;
  if new.locked_at is null
     and (is_broker_owner() or (select auth.jwt() ->> 'email') is null) then
    return new;
  end if;
  if (new.line, new.lines, new.brand, new.valid_until, new.quote_inputs,
      new.client_name, new.client_email, new.contact_id, new.deal_id,
      new.intake_session_id, new.agent_id, new.locked_at)
     is distinct from
     (old.line, old.lines, old.brand, old.valid_until, old.quote_inputs,
      old.client_name, old.client_email, old.contact_id, old.deal_id,
      old.intake_session_id, old.agent_id, old.locked_at) then
    raise exception
      'Quote "%" is closed — it is the record of what this client was offered. Start a new quote instead.',
      coalesce(old.client_name, old.id::text) using errcode = 'restrict_violation';
  end if;
  return new;
end $fn$;

revoke execute on function public.refuse_to_edit_a_locked_quote() from anon, authenticated, public;

-- A quote with any decided product on it must survive. The delete guard keyed
-- only on the quote's own status, which now stays 'sent' or 'interested' while
-- the quote is open and being enrolled from.
create or replace function public.refuse_to_delete_a_locked_quote()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare decided int;
begin
  select count(*) into decided from quote_options o
   where o.quote_id = old.id and o.outcome is not null;
  if decided > 0 then
    raise exception
      'Quote "%" has % product(s) the client enrolled in or waived and cannot be deleted.',
      coalesce(old.client_name, old.id::text), decided
      using errcode = 'restrict_violation';
  end if;
  if coalesce(old.status, '') in ('enrolled', 'locked', 'waived') then
    raise exception
      'Quote "%" is % and cannot be deleted. Unlock it first if this is really intended.',
      coalesce(old.client_name, old.id::text), old.status
      using errcode = 'restrict_violation';
  end if;
  return old;
end $fn$;

revoke execute on function public.refuse_to_delete_a_locked_quote() from anon, authenticated, public;

-- Only a LIVE record holds a product's slot. Found by walking the screen: enrol
-- a product, undo it (which marks the coverage "not taken" rather than deleting
-- it, because coverage is never deleted), then the client changes their mind
-- ten minutes later — and the original unique index refused the second
-- enrollment for good. A withdrawn record is history, not a claim.
drop index if exists public.enrollments_one_per_quote_option;
create unique index if not exists enrollments_one_live_per_quote_option
  on public.enrollments(quote_option_id)
  where quote_option_id is not null and status <> 'withdrawn';
