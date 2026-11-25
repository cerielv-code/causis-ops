
create extension if not exists supabase_vault with schema vault;

create or replace function public.set_email_password(p_account_id uuid, p_password text) returns void
language plpgsql security definer set search_path = public, vault as $$
declare sid uuid; nm text := 'email_pw:' || p_account_id::text;
begin
  if not private.is_operator() then raise exception 'not allowed'; end if;
  if p_password is null or length(p_password) < 1 then raise exception 'empty password'; end if;
  select id into sid from vault.secrets where name = nm;
  if sid is null then perform vault.create_secret(p_password, nm);
  else perform vault.update_secret(sid, p_password); end if;
  update public.email_accounts set last_error = null where id = p_account_id;
end $$;
revoke all on function public.set_email_password(uuid, text) from public, anon;
grant execute on function public.set_email_password(uuid, text) to authenticated;

create or replace function public.get_email_password(p_account_id uuid) returns text
language sql security definer set search_path = public, vault as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'email_pw:' || p_account_id::text limit 1
$$;
revoke all on function public.get_email_password(uuid) from public, anon, authenticated;
grant execute on function public.get_email_password(uuid) to service_role;

create or replace function public.email_password_set(p_account_id uuid) returns boolean
language sql security definer set search_path = public, vault as $$
  select private.is_operator() and exists (select 1 from vault.secrets where name = 'email_pw:' || p_account_id::text)
$$;
revoke all on function public.email_password_set(uuid) from public, anon;
grant execute on function public.email_password_set(uuid) to authenticated;
