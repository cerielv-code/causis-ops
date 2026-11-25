
create table if not exists private.config (key text primary key, value text not null);
insert into private.config values ('cron_secret', encode(gen_random_bytes(24), 'hex')) on conflict do nothing;

create or replace function public.cron_secret_ok(candidate text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from private.config where key='cron_secret' and value = candidate)
$$;
revoke all on function public.cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.cron_secret_ok(text) to service_role;

create or replace function private.call_job(job text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://stbxetfzbssalewbglpg.supabase.co/functions/v1/jobs?job=' || job,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from private.config where key='cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end $$;
revoke all on function private.call_job(text) from public, anon, authenticated;

select cron.schedule('email-sync', '*/3 * * * *', $$select private.call_job('email-sync')$$);
select cron.schedule('email-send', '* * * * *', $$select private.call_job('email-send')$$);
select cron.schedule('x-metrics', '7 * * * *', $$select private.call_job('x-metrics')$$);
