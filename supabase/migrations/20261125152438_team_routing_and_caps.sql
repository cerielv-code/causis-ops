-- Route the panel team's agents to the "team" function, and enforce the global spend caps before any agent starts.
create or replace function private.call_team(slug text, trig text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://stbxetfzbssalewbglpg.supabase.co/functions/v1/team?action=run&slug=' || slug || '&trigger=' || trig,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from private.config where key='cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
end $$;
revoke all on function private.call_team(text, text) from public, anon, authenticated;

create or replace function public.start_agent(p_slug text, p_trigger text default 'manual') returns void
language plpgsql security definer set search_path = public as $$
declare a public.agents; s record;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not private.is_operator() then raise exception 'not allowed'; end if;
  select * into a from public.agents where slug = p_slug;
  if a.id is null then raise exception 'unknown agent'; end if;
  select * into s from public.spend_summary;
  if s.month_usd >= s.monthly_cap_usd or s.today_usd >= s.daily_cap_usd then
    insert into public.agent_runs (agent_id, trigger, status, summary, finished_at)
    values (a.id, p_trigger, 'skipped', case when s.month_usd >= s.monthly_cap_usd then 'Paused: monthly cap of $' || s.monthly_cap_usd || ' reached' else 'Paused: daily cap of $' || s.daily_cap_usd || ' reached, resumes tomorrow' end, now());
    update public.agents set last_run_at = now() where id = a.id;
    return;
  end if;
  if p_slug in ('triage','followup','hygiene','brief','consistency','warmpaths') then
    perform private.call_team(p_slug, p_trigger);
  else
    perform private.call_agents('run&slug=' || p_slug || '&trigger=' || p_trigger);
  end if;
end $$;
revoke all on function public.start_agent(text, text) from public, anon;
grant execute on function public.start_agent(text, text) to authenticated, service_role;

-- Consistency check runs every hour; it costs nothing when there are no new drafts.
update public.agents set every_hours = 1 where slug = 'consistency';
