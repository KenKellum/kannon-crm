-- Ken: unread first, and within those, whoever has waited longest. CRM only —
-- the employer workspace reads get_my_workspace and is untouched.
--
-- "Waited longest" is measured from the OLDEST unread message, not the newest.
-- An employer who sends three messages in a row would otherwise sort as though
-- they had just arrived, jumping ahead of someone who asked once an hour ago and
-- has been sitting there ever since. The wait starts when they first spoke.
--
-- So: unread ahead of read; unread by oldest_unread_at ascending; everything
-- else by recency as before. oldest_unread_at is null for read conversations, so
-- NULLS LAST keeps them out of the way and they fall through to last_at desc.
--
-- The column is returned as well as sorted on, because the list shows a
-- timestamp — showing last_at while sorting on the oldest unread would make a
-- correct order look scrambled.
--
-- GRANTS: widening RETURNS TABLE needs a DROP, and a DROP takes the grants. See
-- 20260807i — Supabase's default privileges silently re-grant EXECUTE to anon on
-- every newly created function, and `revoke ... from public` does NOT undo that,
-- because PUBLIC and anon are different grantees. anon is revoked BY NAME below.
-- Probed after applying: anon receives 42501 permission denied.

drop function if exists public.agent_conversations(text, text);

create or replace function public.agent_conversations(
  p_scope text default 'mine',
  p_show  text default 'active')
returns table(kind text, thread_id uuid, title text, subtitle text,
              last_body text, last_at timestamptz, last_from text,
              last_who text, unread integer, oldest_unread_at timestamptz,
              owner_agent text, is_mine boolean, archived boolean)
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
           (select min(x.created_at) from employer_workspace_messages x
             where x.employer_id = e.id and x.sender_kind = 'employer'
               and x.read_by_agent_at is null) as oldest_unread_at,
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
  order by (t.unread > 0) desc,
           t.oldest_unread_at asc nulls last,
           t.last_at desc;
$$;

revoke all on function public.agent_conversations(text, text) from public;
revoke execute on function public.agent_conversations(text, text) from anon;
grant execute on function public.agent_conversations(text, text) to authenticated;
grant execute on function public.agent_conversations(text, text) to service_role;
