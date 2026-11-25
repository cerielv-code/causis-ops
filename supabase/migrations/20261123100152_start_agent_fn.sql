
create or replace function public.start_agent(p_slug text, p_trigger text default 'manual') returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' and not private.is_operator() then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.agents where slug = p_slug) then raise exception 'unknown agent'; end if;
  perform private.call_agents('run&slug=' || p_slug || '&trigger=' || p_trigger);
end $$;
revoke all on function public.start_agent(text, text) from public, anon;
grant execute on function public.start_agent(text, text) to authenticated, service_role;
