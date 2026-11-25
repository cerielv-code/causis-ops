
create schema if not exists private;
grant usage on schema private to authenticated;
create or replace function private.is_operator() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.operators o
    where lower(o.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
$$;
revoke all on function private.is_operator() from public, anon;
grant execute on function private.is_operator() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['ventures','email_accounts','email_messages','tg_chats','tg_messages','x_accounts','outbox','contacts','deals','tasks','activity','metrics','worker_heartbeat']
  loop
    execute format('alter policy operator_all on public.%I using (private.is_operator()) with check (private.is_operator())', t);
  end loop;
end $$;
alter policy operator_read_self on public.operators using (private.is_operator());
revoke execute on function public.is_operator() from public, anon, authenticated;

-- X tracking (read-only)
create table public.x_account_stats (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.x_accounts(id) on delete cascade,
  followers int, following int, tweet_count int, listed int,
  at timestamptz not null default now()
);
create index on public.x_account_stats (account_id, at desc);

create table public.x_posts (
  id text primary key,                 -- tweet id
  account_id uuid not null references public.x_accounts(id) on delete cascade,
  text text,
  created_at timestamptz,
  likes int default 0, reposts int default 0, replies int default 0, quotes int default 0,
  bookmarks int default 0, impressions int default 0,
  updated_at timestamptz not null default now()
);
create index on public.x_posts (account_id, created_at desc);

alter table public.x_account_stats enable row level security;
alter table public.x_posts enable row level security;
create policy operator_all on public.x_account_stats for all to authenticated using (private.is_operator()) with check (private.is_operator());
create policy operator_all on public.x_posts for all to authenticated using (private.is_operator()) with check (private.is_operator());

-- Email defaults for Namecheap Private Email
alter table public.email_accounts alter column imap_host set default 'mail.privateemail.com';
alter table public.email_accounts alter column smtp_host set default 'mail.privateemail.com';

insert into public.email_accounts (venture_id, label, address, username, secret_ref)
select id, 'Ceriel (Causis)', 'ceriel@causisresearch.com', 'ceriel@causisresearch.com', 'EMAIL_PW_CERIEL_CAUSIS' from public.ventures where slug='causis';
insert into public.email_accounts (venture_id, label, address, username, secret_ref, active)
select id, 'Hello (waitlist)', 'hello@causisresearch.com', 'hello@causisresearch.com', 'EMAIL_PW_HELLO_CAUSIS', false from public.ventures where slug='anna';

create extension if not exists pg_cron;
create extension if not exists pg_net;
