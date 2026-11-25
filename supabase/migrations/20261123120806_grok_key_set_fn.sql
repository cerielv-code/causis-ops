
create or replace function public.grok_key_set(p_bot_id uuid) returns boolean
language sql security definer set search_path = public, vault as $$
  select private.is_operator() and exists (select 1 from vault.secrets where name = 'grok:' || p_bot_id::text)
$$;
revoke all on function public.grok_key_set(uuid) from public, anon;
grant execute on function public.grok_key_set(uuid) to authenticated;
