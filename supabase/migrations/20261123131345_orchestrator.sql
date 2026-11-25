
create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('user','assistant')),
  content text not null,
  actions jsonb not null default '[]',
  cost_usd numeric default 0,
  created_at timestamptz not null default now()
);
create index on public.chat_messages (created_at desc);
alter table public.chat_messages enable row level security;
create policy operator_all on public.chat_messages for all to authenticated using (private.is_operator()) with check (private.is_operator());

insert into public.agents (slug, name, role, enabled, every_hours, model, monthly_budget_usd, sort, instructions)
values ('orchestrator', 'Orchestrator', 'The chat on your Overview. Reads everything, acts on internal things, drafts anything outbound into Approvals', false, 24, 'claude-sonnet-5-5', 25, 0, '');
