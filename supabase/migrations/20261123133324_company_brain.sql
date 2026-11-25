
create table public.initiatives (
  id uuid primary key default gen_random_uuid(),
  area text not null check (area in ('product','research','program','partner','infra','growth')),
  name text not null,
  venture_id uuid references public.ventures(id) on delete set null,
  status text not null default 'in progress' check (status in ('idea','planned','in progress','live','blocked','paused','done')),
  summary text,
  next_step text,
  owner text,
  links jsonb not null default '[]',
  sort int not null default 100,
  updated_at timestamptz not null default now()
);
alter table public.initiatives enable row level security;
create policy operator_all on public.initiatives for all to authenticated using (private.is_operator()) with check (private.is_operator());
alter table public.knowledge add column if not exists sort int not null default 100;
