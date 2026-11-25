create table if not exists public.grok_sends (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid references public.grok_bots(id) on delete cascade,
  kind text not null default 'note',
  note text,
  reply_token text not null unique default encode(gen_random_bytes(18),'hex'),
  webhook_status int,
  webhook_body text,
  replied_at timestamptz,
  reply jsonb,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now()
);
alter table public.grok_sends enable row level security;
create policy grok_sends_operator_read on public.grok_sends for select to authenticated using (private.is_operator());
alter table public.grok_bots add column if not exists last_reply_at timestamptz;
update public.grok_bots set last_report_at = null where name = 'Anna (coordinator)';
