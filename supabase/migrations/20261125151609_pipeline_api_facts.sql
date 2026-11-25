-- Fundraise and partner push: one pipeline, agent API, approvals v2, opportunities, facts sheet, budget.
-- Non-destructive: deals stays as it is (read-only history); nothing is dropped.

-- 1. ONE PIPELINE ---------------------------------------------------------
alter table public.contacts
  add column if not exists type text not null default 'other' check (type in ('investor','partner','tester','press','other')),
  add column if not exists stage text not null default 'lead' check (stage in ('lead','contacted','replied','meeting','diligence','committed','closed','passed','parked')),
  add column if not exists next_step text,
  add column if not exists next_step_date date,
  add column if not exists warm_path text,
  add column if not exists source text,
  add column if not exists owner text not null default 'me',
  add column if not exists last_touch_at timestamptz,
  add column if not exists threads jsonb not null default '[]',
  add column if not exists merged_into uuid references public.contacts(id) on delete set null,
  add column if not exists created_by text not null default 'me';

create index if not exists contacts_name_org_idx on public.contacts (lower(regexp_replace(name, '\s+', '', 'g')), lower(regexp_replace(coalesce(org,''), '\s+', '', 'g')));
create index if not exists contacts_tg_idx on public.contacts (lower(ltrim(telegram, '@')));
create index if not exists contacts_x_idx on public.contacts (lower(ltrim(x_handle, '@')));
create index if not exists contacts_stage_idx on public.contacts (type, stage, next_step_date);

-- Copy each deal onto its contact (one deal per contact today).
update public.contacts c set
  type = case d.pipeline when 'fundraise' then 'investor' when 'partnership' then 'partner' when 'pilot' then 'partner' when 'customer' then 'tester' else 'other' end,
  stage = case d.stage when 'won' then 'closed' when 'lost' then 'passed' else d.stage end,
  next_step = coalesce(c.next_step, d.next_step),
  next_step_date = coalesce(c.next_step_date, d.next_step_date),
  tags = case when d.pipeline = 'grant' and not ('grant' = any(c.tags)) then array_append(c.tags, 'grant') else c.tags end,
  notes = case when d.notes is not null and coalesce(c.notes,'') not like '%' || d.notes || '%' then concat_ws(E'\n', c.notes, d.notes) else c.notes end,
  source = coalesce(c.source, 'scout agent'),
  owner = 'scout',
  created_by = 'scout'
from public.deals d where d.contact_id = c.id;

-- Duplicate finder: same name+org, same email, same Telegram or X handle.
create or replace function public.contact_duplicates() returns table (a uuid, b uuid, reason text)
language sql stable security definer set search_path = public as $$
  with c as (select * from public.contacts where merged_into is null)
  select x.id, y.id, 'name and organisation' from c x join c y on x.id < y.id
    and lower(regexp_replace(x.name,'\s+','','g')) = lower(regexp_replace(y.name,'\s+','','g'))
    and lower(regexp_replace(coalesce(x.org,''),'\s+','','g')) = lower(regexp_replace(coalesce(y.org,''),'\s+','','g'))
  union select x.id, y.id, 'email' from c x join c y on x.id < y.id and x.email is not null and lower(x.email) = lower(y.email)
  union select x.id, y.id, 'telegram' from c x join c y on x.id < y.id and coalesce(x.telegram,'') <> '' and lower(ltrim(x.telegram,'@')) = lower(ltrim(y.telegram,'@'))
  union select x.id, y.id, 'x handle' from c x join c y on x.id < y.id and coalesce(x.x_handle,'') <> '' and lower(ltrim(x.x_handle,'@')) = lower(ltrim(y.x_handle,'@'))
$$;
revoke all on function public.contact_duplicates() from public, anon;
grant execute on function public.contact_duplicates() to authenticated, service_role;

-- Merge: moves everything to the kept contact and marks the other as merged. Nothing is deleted.
create or replace function public.merge_contacts(p_keep uuid, p_merge uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.contacts;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not private.is_operator() then raise exception 'not allowed'; end if;
  if p_keep = p_merge then return; end if;
  select * into m from public.contacts where id = p_merge;
  update public.contacts k set
    org = coalesce(k.org, m.org), role = coalesce(k.role, m.role), email = coalesce(k.email, m.email),
    telegram = coalesce(k.telegram, m.telegram), x_handle = coalesce(k.x_handle, m.x_handle), linkedin = coalesce(k.linkedin, m.linkedin),
    warm_path = coalesce(k.warm_path, m.warm_path), next_step = coalesce(k.next_step, m.next_step), next_step_date = coalesce(k.next_step_date, m.next_step_date),
    tags = (select array(select distinct unnest(k.tags || m.tags))), threads = k.threads || m.threads,
    notes = concat_ws(E'\n', k.notes, m.notes), last_touch_at = greatest(k.last_touch_at, m.last_touch_at)
  where k.id = p_keep;
  update public.contacts set merged_into = p_keep where id = p_merge;
  update public.deals set contact_id = p_keep where contact_id = p_merge;
  update public.email_messages set contact_id = p_keep where contact_id = p_merge;
  update public.contact_activities set contact_id = p_keep where contact_id = p_merge;
  update public.approvals set contact_id = p_keep where contact_id = p_merge;
  update public.opportunities set contact_id = p_keep where contact_id = p_merge;
end $$;

create table if not exists public.contact_activities (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  kind text not null check (kind in ('email','telegram','x','linkedin','call','meeting','intro','note','other')),
  direction text check (direction in ('in','out')),
  summary text not null,
  url text,
  actor text not null default 'me',
  happened_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists contact_activities_contact_idx on public.contact_activities (contact_id, happened_at desc);

create or replace function private.touch_contact() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.contacts set last_touch_at = greatest(coalesce(last_touch_at, new.happened_at), new.happened_at) where id = new.contact_id;
  return new;
end $$;
create trigger t_contact_activity after insert on public.contact_activities for each row execute function private.touch_contact();

-- Seed activities from deals' history so last touch is not empty.
insert into public.contact_activities (contact_id, kind, summary, actor, happened_at)
select d.contact_id, 'note', 'Imported from deal: ' || d.title || ' (' || d.stage || ')', 'import', d.updated_at from public.deals d where d.contact_id is not null;

-- 2. AGENT API: tokens, audit, idempotency ---------------------------------
create table if not exists public.agent_tokens (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  team text not null default 'grok',
  prefix text not null,
  token_hash text not null unique,
  rate_per_min int not null default 60,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.api_audit (
  id bigint generated always as identity primary key,
  token_id uuid references public.agent_tokens(id) on delete set null,
  agent_name text,
  method text, path text, status int,
  idempotency_key text,
  request jsonb,
  error text,
  ms int,
  created_at timestamptz not null default now()
);
create index if not exists api_audit_token_idx on public.api_audit (token_id, created_at desc);
create index if not exists api_audit_time_idx on public.api_audit (created_at desc);

create table if not exists public.api_idempotency (
  token_id uuid not null references public.agent_tokens(id) on delete cascade,
  key text not null,
  status int not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (token_id, key)
);

-- Create a token: returns the raw token once; only its hash is kept.
create or replace function public.create_agent_token(p_name text, p_team text default 'grok') returns text
language plpgsql security definer set search_path = public, extensions as $$
declare raw text := 'cro_' || encode(gen_random_bytes(24), 'hex');
begin
  if not private.is_operator() then raise exception 'not allowed'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name required'; end if;
  insert into public.agent_tokens (name, team, prefix, token_hash) values (trim(p_name), coalesce(p_team,'grok'), left(raw, 10), encode(digest(raw, 'sha256'), 'hex'));
  return raw;
end $$;
revoke all on function public.create_agent_token(text, text) from public, anon;
grant execute on function public.create_agent_token(text, text) to authenticated;

-- 3. APPROVALS v2 and OPPORTUNITIES ------------------------------------------
alter table public.approvals
  add column if not exists channel text check (channel in ('email','telegram','x','linkedin','other')),
  add column if not exists recipient text,
  add column if not exists why_now text,
  add column if not exists risk text not null default 'low' check (risk in ('low','medium','high')),
  add column if not exists source text not null default 'panel',
  add column if not exists submitted_by text,
  add column if not exists token_id uuid references public.agent_tokens(id) on delete set null,
  add column if not exists contact_id uuid references public.contacts(id) on delete set null,
  add column if not exists external_ref text,
  add column if not exists decision text check (decision in ('approved','edited','rejected','expired')),
  add column if not exists final_text text,
  add column if not exists decision_note text,
  add column if not exists consistency jsonb;
create index if not exists approvals_token_idx on public.approvals (token_id, created_at desc);

update public.approvals set channel = case
    when kind = 'email' then 'email'
    when kind = 'x_post' then 'x'
    when lower(coalesce(payload->>'channel','')) in ('email','telegram','x','linkedin') then lower(payload->>'channel')
    else 'other' end
where channel is null;
update public.approvals set submitted_by = coalesce(submitted_by, (select a.name from public.agents a where a.id = approvals.agent_id)) where agent_id is not null;

-- Old drafts that are no longer relevant: marketing X drafts, the Grok note, and anything older than 2 days.
update public.approvals set status = 'done', decision = 'expired', decided_at = now()
where status = 'pending' and (kind in ('x_post','grok_note') or created_at < now() - interval '2 days');

create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  reason text not null,
  suggested_action text,
  score int not null default 50 check (score between 0 and 100),
  urgency text not null default 'normal' check (urgency in ('low','normal','urgent')),
  type text not null default 'other' check (type in ('investor','partner','tester','press','intro','event','grant','other')),
  url text,
  contact_id uuid references public.contacts(id) on delete set null,
  source text not null default 'panel',
  submitted_by text,
  token_id uuid references public.agent_tokens(id) on delete set null,
  external_ref text,
  status text not null default 'open' check (status in ('open','accepted','dismissed','done')),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists opportunities_open_idx on public.opportunities (status, score desc, created_at desc);

create table if not exists public.agent_reports (
  id uuid primary key default gen_random_uuid(),
  agent_name text not null,
  token_id uuid references public.agent_tokens(id) on delete set null,
  day date not null default (now() at time zone 'Europe/Amsterdam')::date,
  summary text not null,
  metrics jsonb not null default '{}',
  items jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index if not exists agent_reports_day_idx on public.agent_reports (day desc, created_at desc);

-- 4. FACTS SHEET (versioned) -----------------------------------------------------
create table if not exists public.facts_versions (
  version int generated always as identity primary key,
  content text not null,
  note text,
  edited_by text not null default 'me',
  created_at timestamptz not null default now()
);

-- 5. BUDGET ---------------------------------------------------------------------
create table if not exists public.budget (
  id int primary key default 1 check (id = 1),
  monthly_usd numeric not null default 100,
  daily_usd numeric not null default 3.3,
  updated_at timestamptz not null default now()
);
insert into public.budget (id) values (1) on conflict do nothing;

create or replace view public.spend_summary with (security_invoker = true) as
select
  coalesce(sum(cost_usd) filter (where started_at >= (date_trunc('day', now() at time zone 'Europe/Amsterdam') at time zone 'Europe/Amsterdam')), 0) as today_usd,
  coalesce(sum(cost_usd) filter (where started_at >= (date_trunc('month', now() at time zone 'Europe/Amsterdam') at time zone 'Europe/Amsterdam')), 0) as month_usd,
  (select daily_usd from public.budget where id = 1) as daily_cap_usd,
  (select monthly_usd from public.budget where id = 1) as monthly_cap_usd
from public.agent_runs;

-- RLS -------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['contact_activities','agent_tokens','api_audit','opportunities','agent_reports','facts_versions','budget'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy operator_all on public.%I for all to authenticated using (private.is_operator()) with check (private.is_operator())', t);
  end loop;
end $$;
alter table public.api_idempotency enable row level security;   -- service role only
revoke all on public.agent_tokens from anon;
alter publication supabase_realtime add table public.opportunities;

-- 6. AGENT LINEUP -------------------------------------------------------------
update public.agents set enabled = false, role = 'Paused: CR Social now handles X. Kept for reference.' where slug = 'marketing';
update public.agents set enabled = false, role = 'Paused: CR Team now scouts and drafts outreach. Replaced by Warm paths.' where slug = 'scout';
update public.agents set enabled = false, role = 'Replaced by Inbox triage and Daily brief.' where slug = 'chief';

insert into public.agents (slug, name, role, enabled, every_hours, at_hour, model, monthly_budget_usd, sort, instructions) values
 ('triage', 'Inbox triage', 'Matches new email and Telegram to contacts, summarises, logs the touch, drafts replies into Approvals', true, 2, null, 'claude-haiku-5-5', 25, 1, ''),
 ('followup', 'Follow-up', 'Finds threads where we wrote last and got no reply in 4 days, drafts a short nudge', true, 24, 9, 'claude-haiku-5-5', 8, 2, ''),
 ('hygiene', 'Hygiene', 'Merges clear duplicates, fills missing fields from email and Telegram, flags contacts with no next step', true, 24, 6, 'claude-haiku-5-5', 5, 3, ''),
 ('brief', 'Daily brief', 'Writes the Overview brief: what happened, what needs you, what is next', true, 24, 7, 'claude-haiku-5-5', 6, 4, ''),
 ('consistency', 'Consistency check', 'Checks every outbound draft against the facts sheet and flags contradictions', true, 1, null, 'claude-haiku-5-5', 8, 5, ''),
 ('warmpaths', 'Warm paths', 'For open investors and partners, finds who in our own email, Telegram and contacts could introduce us, and posts opportunities', true, 24, 10, 'claude-haiku-5-5', 8, 6, '')
on conflict (slug) do nothing;
update public.agents set monthly_budget_usd = 15 where slug = 'orchestrator';
update public.agents set monthly_budget_usd = 10, every_hours = 168 where slug = 'seo';

-- 7. FACTS SHEET, version 1 (from the 25 Nov deck and data room) ---------------
insert into public.facts_versions (content, note, edited_by) values ($facts$# Causis Research facts sheet

Approved messaging. Agents use only what is here. If something is not here, do not claim it.

## Causis Research
- Independent AI lab. Own architecture built from first principles. Not a transformer, runs on CPU, keeps learning from new data without retraining.
- Founded April 2026 by Ceriel van den Adel (commercial) and Sergei Golovach (technical, sole architect). Delaware C-Corp. Netherlands-led team.
- Core infra: Aitia (causal engine) and CR-Stream (learning substrate). Exact model merge is solved.
- One line: Every AI model stops learning the day it ships. Ours do not.

## Check (model 1)
- What it is: a model that verifies AI answers against what you know, and returns verified, contradicted or unknown, with the proof.
- Status: in development. Ships first. Callable through an API and inference platforms in 2027.
- For users:
  - Stops hallucinations before they ship: every LLM answer is checked against your own facts and rules before a customer sees it.
  - Gives an audit trail: each verdict comes with the facts it rests on, which compliance and legal teams can inspect.
  - Stays current: a new policy or fact counts from the next check, without retraining anything.
- Built on Aitia. Demo and research: aitia.causisresearch.com

## Memory (model 2)
- What it is: a model that remembers for your AI, so you stop sending the same context with every call.
- Status: in development. Follows Check.
- For users:
  - Cuts cost and latency: stop paying to resend documents, history and instructions on every request.
  - Ends forgetting: anything taught once is known on the next call, in every session, with no retraining or re-indexing.
  - Makes knowledge shareable and controllable: teams and agents merge their memories into one, and can see why it gave an answer.
- Runs on CR-Stream. Exact merge is live at merge.causisresearch.com

## Anna
- What it is: the messenger where people and AI agents work together. One message, a whole team. The first product our models go into: Check verifies what her agents produce, Memory keeps what a team teaches her.
- Status: private beta with about 10 teams, waitlist of about 500, no paid marketing yet. Runs on the best LLMs today.
- Links: annaos.ai, annaos.org/show

## Proof points (internal results, 3 seeds each, baselines named)
- Counterfactual accuracy, Lorenz system: 35 to 48x better than an average-trajectory baseline.
- Counterfactual accuracy, 7-gene network: 791 to 1105x better than an average-trajectory baseline.
- 11 domains in one model, no regression when one is added.
- Physics improved 10.7% by learning text (transfer across domains).
- Two agents invented a protocol: 10x vs random, no pretrained model.
- 250+ experiments, 0 GPUs, a few thousand dollars in total.
- Exact merge: two separately trained models combine exactly, any order, no raw data shared. Live demo.
- Live demos (real engine, on CPU): merge.causisresearch.com, aitia.causisresearch.com, quantum.causisresearch.com

## The round
- Raising $1M to $1.5M pre-seed on a SAFE.
- Next: outside review, Technical Report 1, first pilots with partners.

## What we never say
- Never claim a language model, or that we beat GPT, Claude or any frontier model. We claim four things frozen models cannot do: learn after training, exact merge, cause and counterfactuals, cost per answer.
- Never say results are third-party verified. They are internal; a third-party run is next.
- Never say Check or Memory are available, shipping or in customer use. Both are in development.
- Never quote a round size other than $1M to $1.5M, and no valuation.
- Never name customers, pilots or partners as signed unless listed here.
- Never inflate Anna numbers: about 10 teams in beta, about 500 on the waitlist.
- Never quote the upper end of a proof range without saying it is the upper end, and always name the baseline.
- Never say AGI, "transformer killer", or "revolutionary".
$facts$, 'First version from the 25 Nov deck and data room', 'import');
