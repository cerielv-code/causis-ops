
create extension if not exists pgcrypto;

-- who may use the panel
create table public.operators (
  email text primary key,
  name text,
  created_at timestamptz not null default now()
);

create or replace function public.is_operator() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.operators o
    where lower(o.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  ) and coalesce((auth.jwt() ->> 'email_verified')::boolean, true)
$$;
revoke all on function public.is_operator() from public;
grant execute on function public.is_operator() to authenticated;

create table public.ventures (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  color text not null default '#888888',
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- EMAIL (IMAP/SMTP). Passwords never live here: the worker reads them from env by secret_ref.
create table public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid references public.ventures(id) on delete set null,
  label text not null,
  address text not null unique,
  imap_host text, imap_port int default 993,
  smtp_host text, smtp_port int default 465,
  username text,
  secret_ref text not null,            -- env var name holding the password, e.g. EMAIL_PW_CERIEL_CAUSIS
  active boolean not null default true,
  last_uid bigint default 0,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table public.email_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.email_accounts(id) on delete cascade,
  venture_id uuid references public.ventures(id) on delete set null,
  uid bigint not null,
  message_id text,
  in_reply_to text,
  thread_key text,
  from_addr text, from_name text,
  to_addrs text[],
  cc_addrs text[],
  subject text,
  snippet text,
  body_text text,
  received_at timestamptz,
  is_read boolean not null default false,
  status text not null default 'inbox' check (status in ('inbox','todo','waiting','archived')),
  labels text[] not null default '{}',
  contact_id uuid,
  created_at timestamptz not null default now(),
  unique (account_id, uid)
);
create index on public.email_messages (venture_id, received_at desc);
create index on public.email_messages (status, received_at desc);

-- TELEGRAM (personal account via MTProto worker)
create table public.tg_chats (
  id bigint primary key,
  title text,
  kind text,                           -- user | group | channel
  username text,
  venture_id uuid references public.ventures(id) on delete set null,
  tracked boolean not null default false,  -- only tracked chats get message history synced
  pinned boolean not null default false,
  unread_count int default 0,
  last_message_at timestamptz,
  last_message_preview text,
  updated_at timestamptz not null default now()
);
create index on public.tg_chats (last_message_at desc);

create table public.tg_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null references public.tg_chats(id) on delete cascade,
  tg_msg_id bigint not null,
  sender_id bigint,
  sender_name text,
  text text,
  is_outgoing boolean not null default false,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (chat_id, tg_msg_id)
);
create index on public.tg_messages (chat_id, sent_at desc);

-- X accounts. Tokens live in a private table with no client access.
create table public.x_accounts (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid references public.ventures(id) on delete set null,
  handle text not null unique,
  display_name text,
  x_user_id text,
  connected boolean not null default false,
  followers int,
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.x_tokens (
  account_id uuid primary key references public.x_accounts(id) on delete cascade,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  scope text,
  updated_at timestamptz not null default now()
);

create table public.x_oauth_states (
  state text primary key,
  account_id uuid not null references public.x_accounts(id) on delete cascade,
  code_verifier text not null,
  created_at timestamptz not null default now()
);

-- One outbox for every channel. The worker sends anything queued and due.
create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('email','telegram','x')),
  venture_id uuid references public.ventures(id) on delete set null,
  email_account_id uuid references public.email_accounts(id) on delete set null,
  x_account_id uuid references public.x_accounts(id) on delete set null,
  tg_chat_id bigint references public.tg_chats(id) on delete set null,
  payload jsonb not null default '{}',   -- email: {to,cc,subject,body,in_reply_to}; telegram: {text}; x: {text, reply_to}
  status text not null default 'draft' check (status in ('draft','queued','sending','sent','failed')),
  scheduled_for timestamptz,
  attempts int not null default 0,
  error text,
  result jsonb,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.outbox (status, scheduled_for);

-- CRM
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid references public.ventures(id) on delete set null,
  name text not null,
  org text,
  role text,
  email text,
  telegram text,
  x_handle text,
  linkedin text,
  tags text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.contacts (lower(email));

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid references public.ventures(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  title text not null,
  pipeline text not null default 'fundraise' check (pipeline in ('fundraise','partnership','pilot','grant','customer')),
  stage text not null default 'lead' check (stage in ('lead','contacted','meeting','diligence','committed','won','lost','parked')),
  amount_usd numeric,
  next_step text,
  next_step_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid references public.ventures(id) on delete set null,
  deal_id uuid references public.deals(id) on delete set null,
  title text not null,
  notes text,
  status text not null default 'todo' check (status in ('todo','doing','done')),
  priority int not null default 2 check (priority between 1 and 3),
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.activity (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid references public.ventures(id) on delete set null,
  kind text not null,
  summary text not null,
  ref jsonb,
  created_at timestamptz not null default now()
);
create index on public.activity (created_at desc);

-- Placeholder for later modules (product data, marketing metrics)
create table public.metrics (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid references public.ventures(id) on delete set null,
  source text not null,     -- e.g. 'anna_app', 'waitlist', 'x', 'site'
  metric text not null,     -- e.g. 'waitlist_signups', 'followers'
  value numeric not null,
  at timestamptz not null default now()
);
create index on public.metrics (venture_id, metric, at desc);

create table public.worker_heartbeat (
  name text primary key,
  last_seen timestamptz not null default now(),
  info jsonb
);

-- updated_at triggers
create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;
create trigger t_outbox before update on public.outbox for each row execute function public.touch_updated_at();
create trigger t_contacts before update on public.contacts for each row execute function public.touch_updated_at();
create trigger t_deals before update on public.deals for each row execute function public.touch_updated_at();
create trigger t_tasks before update on public.tasks for each row execute function public.touch_updated_at();

-- RLS: operators get full access to app tables; private tables get none.
do $$
declare t text;
begin
  foreach t in array array['ventures','email_accounts','email_messages','tg_chats','tg_messages','x_accounts','outbox','contacts','deals','tasks','activity','metrics','worker_heartbeat']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy operator_all on public.%I for all to authenticated using (public.is_operator()) with check (public.is_operator())', t);
  end loop;
end $$;
alter table public.operators enable row level security;
create policy operator_read_self on public.operators for select to authenticated using (public.is_operator());
alter table public.x_tokens enable row level security;        -- no policies: service role only
alter table public.x_oauth_states enable row level security;  -- no policies: service role only

-- Realtime for live inbox / chats / outbox
alter publication supabase_realtime add table public.email_messages, public.tg_messages, public.tg_chats, public.outbox;

-- Seed
insert into public.operators (email, name) values ('ceriel@causisresearch.com', 'Ceriel');
insert into public.ventures (slug, name, color, sort) values
  ('causis', 'Causis Research', '#8B1A2F', 1),
  ('anna', 'Anna', '#FD6415', 2);
insert into public.x_accounts (venture_id, handle)
  select id, 'causisresearch' from public.ventures where slug = 'causis';
insert into public.x_accounts (venture_id, handle)
  select id, 'annaos_ai' from public.ventures where slug = 'anna';
