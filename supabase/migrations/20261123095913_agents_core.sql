
create table public.agents (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  role text not null,
  venture_id uuid references public.ventures(id) on delete set null,
  enabled boolean not null default false,
  every_hours int not null default 24,
  at_hour int,                       -- Amsterdam local hour, null = any
  weekday int,                       -- 1=Mon..7=Sun, null = every day
  model text not null default 'claude-sonnet-5-5',
  instructions text not null default '',
  monthly_budget_usd numeric not null default 30,
  last_run_at timestamptz,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.agents(id) on delete cascade,
  trigger text not null default 'schedule',
  status text not null default 'running' check (status in ('running','done','failed','skipped')),
  summary text,
  output jsonb,
  tokens_in int default 0, tokens_out int default 0, searches int default 0,
  cost_usd numeric default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index on public.agent_runs (agent_id, started_at desc);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references public.agents(id) on delete set null,
  run_id uuid references public.agent_runs(id) on delete set null,
  venture_id uuid references public.ventures(id) on delete set null,
  kind text not null check (kind in ('email','x_post','outreach','grok_note','content','other')),
  title text not null,
  body text,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending','approved','rejected','done')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.approvals (status, created_at desc);

create table public.knowledge (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid references public.ventures(id) on delete set null,
  key text unique not null,
  title text not null,
  content text not null default '',
  updated_at timestamptz not null default now()
);

create table public.aeo_prompts (
  id uuid primary key default gen_random_uuid(),
  venture_id uuid references public.ventures(id) on delete set null,
  prompt text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.aeo_results (
  id uuid primary key default gen_random_uuid(),
  prompt_id uuid not null references public.aeo_prompts(id) on delete cascade,
  engine text not null,
  mentioned_causis boolean, mentioned_anna boolean,
  competitors text[] default '{}',
  excerpt text,
  run_id uuid references public.agent_runs(id) on delete set null,
  at timestamptz not null default now()
);
create index on public.aeo_results (prompt_id, at desc);

create table public.seo_audits (
  id uuid primary key default gen_random_uuid(),
  site text not null,
  score int,
  checks jsonb,
  recommendations jsonb,
  run_id uuid references public.agent_runs(id) on delete set null,
  at timestamptz not null default now()
);

create table public.briefs (
  id uuid primary key default gen_random_uuid(),
  day date not null default (now() at time zone 'Europe/Amsterdam')::date,
  content text not null,
  run_id uuid references public.agent_runs(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.email_messages add column if not exists priority text, add column if not exists category text, add column if not exists ai_note text, add column if not exists triaged_at timestamptz;

do $$
declare t text;
begin
  foreach t in array array['agents','agent_runs','approvals','knowledge','aeo_prompts','aeo_results','seo_audits','briefs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy operator_all on public.%I for all to authenticated using (private.is_operator()) with check (private.is_operator())', t);
  end loop;
end $$;
alter publication supabase_realtime add table public.approvals, public.agent_runs;

-- allow the Anthropic key in app secrets
create or replace function public.set_app_secret(p_name text, p_value text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid; nm text := 'app:' || p_name;
begin
  if not private.is_operator() then raise exception 'not allowed'; end if;
  if p_name not in ('x_bearer','anthropic') then raise exception 'unknown secret'; end if;
  select id into sid from vault.secrets where name = nm;
  if sid is null then perform vault.create_secret(p_value, nm); else perform vault.update_secret(sid, p_value); end if;
end $$;

-- scheduler tick every 15 min
select cron.schedule('agents-tick', '*/15 * * * *', $$select private.call_agents('tick')$$);
