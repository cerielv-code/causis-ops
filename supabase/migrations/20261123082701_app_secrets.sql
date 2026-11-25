
create or replace function public.set_app_secret(p_name text, p_value text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid; nm text := 'app:' || p_name;
begin
  if not private.is_operator() then raise exception 'not allowed'; end if;
  if p_name not in ('x_bearer') then raise exception 'unknown secret'; end if;
  select id into sid from vault.secrets where name = nm;
  if sid is null then perform vault.create_secret(p_value, nm); else perform vault.update_secret(sid, p_value); end if;
end $$;
revoke all on function public.set_app_secret(text, text) from public, anon;
grant execute on function public.set_app_secret(text, text) to authenticated;

create or replace function public.get_app_secret(p_name text) returns text
language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'app:' || p_name limit 1
$$;
revoke all on function public.get_app_secret(text) from public, anon, authenticated;
grant execute on function public.get_app_secret(text) to service_role;

create or replace function public.app_secret_set(p_name text) returns boolean
language sql security definer set search_path = public, vault as $$
  select private.is_operator() and exists (select 1 from vault.secrets where name = 'app:' || p_name)
$$;
revoke all on function public.app_secret_set(text) from public, anon;
grant execute on function public.app_secret_set(text) to authenticated;
