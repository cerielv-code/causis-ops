
create table public.tg_accounts (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  connected boolean not null default false,
  me jsonb,
  stage text,
  last_sync_at timestamptz,
  last_error text,
  legacy boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.tg_dialogs (
  account_id uuid not null references public.tg_accounts(id) on delete cascade,
  id bigint not null,
  title text, kind text, username text,
  venture_id uuid references public.ventures(id) on delete set null,
  tracked boolean not null default false,
  pinned boolean not null default false,
  unread_count int default 0,
  last_message_at timestamptz,
  last_message_preview text,
  last_msg_id bigint default 0,
  updated_at timestamptz not null default now(),
  primary key (account_id, id)
);
create index on public.tg_dialogs (last_message_at desc);
create table public.tg_msgs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  chat_id bigint not null,
  tg_msg_id bigint not null,
  sender_id bigint, sender_name text, text text,
  is_outgoing boolean not null default false,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_id, chat_id, tg_msg_id),
  foreign key (account_id, chat_id) references public.tg_dialogs(account_id, id) on delete cascade
);
create index on public.tg_msgs (account_id, chat_id, sent_at desc);

do $$ declare t text; begin
  foreach t in array array['tg_accounts','tg_dialogs','tg_msgs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy operator_all on public.%I for all to authenticated using (private.is_operator()) with check (private.is_operator())', t);
  end loop;
end $$;

insert into public.tg_accounts (label, connected, me, legacy)
select coalesce('@' || (me->>'username'), 'Main account'), connected, me, true from public.tg_status where id = 1 and connected;
insert into public.tg_accounts (label) values ('@notinvariant');
