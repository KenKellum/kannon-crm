-- The spoken announcement needs the PERSON, not just the company.
--
-- subtitle was already close but not correct for this: it is the most recently
-- ACTIVATED workspace member, which is who the workspace belongs to rather than
-- who just wrote. Two people share a workspace and it names the wrong one.
-- Every message already stores sender_name, so return that instead of inferring.
--
-- Changing a function's OUT columns needs a DROP; CREATE OR REPLACE cannot widen
-- a RETURNS TABLE. Grants do not survive a DROP, so they are restored below.
--
-- No new exposure: sender_name already reaches this same audience through
-- agent_thread, and the row filter (is_an_agent + can_see_agent_work) is
-- untouched. This adds a column, not a reader.
--
-- SEE 20260807i — the grant restoration below is INCOMPLETE, and probing caught
-- it. Read that file before copying this pattern anywhere.

drop function if exists public.agent_conversations(text, text);

create or replace function public.agent_conversations(
  p_scope text default 'mine',
  p_show  text default 'active')
returns table(kind text, thread_id uuid, title text, subtitle text,
              last_body text, last_at timestamptz, last_from text,
              last_who text, unread integer, owner_agent text,
              is_mine boolean, archived boolean)
language sql stable security definer set search_path to 'public'
as $$
  with me as (select id from agents where lower(email) = lower(auth.jwt() ->> 'email'))
  select * from (
    select 'employer'::text as kind,
           e.id as thread_id,
           coalesce(e.dba, e.legal_name) as title,
           coalesce((select c.name from employer_workspace_members m
                      join contacts c on c.id = m.contact_id
                     where m.employer_id = e.id and m.status = 'active'
                     order by m.activated_at desc limit 1), 'Workspace') as subtitle,
           last.body as last_body,
           last.created_at as last_at,
           last.sender_kind as last_from,
           last.sender_name as last_who,
           coalesce((select count(*)::int from employer_workspace_messages x
                      where x.employer_id = e.id and x.sender_kind = 'employer'
                        and x.read_by_agent_at is null), 0) as unread,
           coalesce(ag.display_name, ag.name) as owner_agent,
           (e.primary_agent_id = (select id from me)) as is_mine,
           -- Strict: a message at the same instant as the archive is NEW.
           (cs.archived_at is not null and last.created_at < cs.archived_at) as archived
      from employers e
      left join agents ag on ag.id = e.primary_agent_id
      left join conversation_state cs on cs.kind = 'employer' and cs.thread_id = e.id
      join lateral (
        select m.body, m.created_at, m.sender_kind, m.sender_name
          from employer_workspace_messages m
         where m.employer_id = e.id
         order by m.created_at desc limit 1) last on true
     where is_an_agent()
       and can_see_agent_work(e.primary_agent_id)
       and (coalesce(p_scope,'mine') <> 'mine' or e.primary_agent_id = (select id from me))
  ) t
  where t.archived = (coalesce(p_show,'active') = 'archived')
  order by t.last_at desc;
$$;

revoke all on function public.agent_conversations(text, text) from public;
grant execute on function public.agent_conversations(text, text) to authenticated;
grant execute on function public.agent_conversations(text, text) to service_role;
