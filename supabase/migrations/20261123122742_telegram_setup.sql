
create or replace function public.set_app_secret(p_name text, p_value text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid; nm text := 'app:' || p_name;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not private.is_operator() then raise exception 'not allowed'; end if;
  if coalesce(auth.role(), '') <> 'service_role' and p_name not in ('x_bearer','anthropic','tg_api_id','tg_api_hash') then raise exception 'unknown secret'; end if;
  select id into sid from vault.secrets where name = nm;
  if sid is null then perform vault.create_secret(p_value, nm); else perform vault.update_secret(sid, p_value); end if;
end $$;
grant execute on function public.set_app_secret(text, text) to service_role;

alter table public.tg_chats add column if not exists last_msg_id bigint default 0, add column if not exists is_muted boolean default false;
create table if not exists public.tg_status (
  id int primary key default 1 check (id = 1),
  connected boolean not null default false,
  me jsonb,
  stage text,             -- null | code_sent | password_needed
  last_sync_at timestamptz,
  last_error text
);
insert into public.tg_status (id) values (1) on conflict do nothing;
alter table public.tg_status enable row level security;
create policy operator_all on public.tg_status for all to authenticated using (private.is_operator()) with check (private.is_operator());

select cron.schedule('telegram-sync', '*/5 * * * *', $$select private.call_fn('telegram', 'sync')$$);

create or replace function private.call_fn(fn text, action text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://stbxetfzbssalewbglpg.supabase.co/functions/v1/' || fn || '?action=' || action,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select value from private.config where key='cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
end $$;
revoke all on function private.call_fn(text, text) from public, anon, authenticated;
