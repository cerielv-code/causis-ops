-- Only addresses in public.operators can create a login.
create or replace function private.only_operators_can_sign_up() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.operators o where lower(o.email) = lower(new.email)) then
    raise exception 'Sign-ups are closed';
  end if;
  return new;
end $$;
create trigger only_operators_can_sign_up
  before insert on auth.users
  for each row execute function private.only_operators_can_sign_up();
