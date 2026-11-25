-- Database-level duplicate guards, so two agents writing at the same moment cannot create the same contact twice.
-- Merged contacts are excluded, so merges keep working.
create unique index if not exists contacts_unique_name_org on public.contacts
  (lower(regexp_replace(name, '\s+', '', 'g')), lower(regexp_replace(coalesce(org,''), '\s+', '', 'g'))) where merged_into is null;
create unique index if not exists contacts_unique_email on public.contacts (lower(email)) where merged_into is null and email is not null and email <> '';
create unique index if not exists contacts_unique_tg on public.contacts (lower(ltrim(telegram, '@'))) where merged_into is null and telegram is not null and telegram <> '';
create unique index if not exists contacts_unique_x on public.contacts (lower(ltrim(x_handle, '@'))) where merged_into is null and x_handle is not null and x_handle <> '';
