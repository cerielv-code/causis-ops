
create table public.grok_bots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  handle text,
  venture_id uuid references public.ventures(id) on delete set null,
  webhook_url text,
  last_sent_at timestamptz,
  last_report_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.grok_reports (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid references public.grok_bots(id) on delete set null,
  bot_name text,
  summary text,
  posts jsonb,
  raw jsonb,
  created_at timestamptz not null default now()
);
alter table public.grok_bots enable row level security;
alter table public.grok_reports enable row level security;
create policy operator_all on public.grok_bots for all to authenticated using (private.is_operator()) with check (private.is_operator());
create policy operator_all on public.grok_reports for all to authenticated using (private.is_operator()) with check (private.is_operator());

insert into private.config values ('grok_report_token', encode(gen_random_bytes(24), 'hex')) on conflict do nothing;

create or replace function public.get_grok_report_token() returns text
language sql security definer set search_path = public as $$
  select case when private.is_operator() then (select value from private.config where key='grok_report_token') end
$$;
revoke all on function public.get_grok_report_token() from public, anon;
grant execute on function public.get_grok_report_token() to authenticated;

create or replace function public.grok_report_token_ok(candidate text) returns boolean
language sql security definer set search_path = public as $$
  select exists (select 1 from private.config where key='grok_report_token' and value = candidate)
$$;
revoke all on function public.grok_report_token_ok(text) from public, anon, authenticated;
grant execute on function public.grok_report_token_ok(text) to service_role;

create or replace function public.set_grok_key(p_bot_id uuid, p_key text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid; nm text := 'grok:' || p_bot_id::text;
begin
  if not private.is_operator() then raise exception 'not allowed'; end if;
  select id into sid from vault.secrets where name = nm;
  if sid is null then perform vault.create_secret(p_key, nm); else perform vault.update_secret(sid, p_key); end if;
end $$;
revoke all on function public.set_grok_key(uuid, text) from public, anon;
grant execute on function public.set_grok_key(uuid, text) to authenticated;

create or replace function public.get_grok_key(p_bot_id uuid) returns text
language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'grok:' || p_bot_id::text limit 1
$$;
revoke all on function public.get_grok_key(uuid) from public, anon, authenticated;
grant execute on function public.get_grok_key(uuid) to service_role;

insert into public.grok_bots (name, handle, venture_id) values
  ('Anna poster', 'annaos_ai', (select id from public.ventures where slug='anna')),
  ('Invariant poster', 'notinvariant', null);
