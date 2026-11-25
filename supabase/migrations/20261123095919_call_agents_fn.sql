
create or replace function private.call_agents(action text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://stbxetfzbssalewbglpg.supabase.co/functions/v1/agents?action=' || action,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from private.config where key='cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
end $$;
revoke all on function private.call_agents(text) from public, anon, authenticated;
