
update public.email_messages m set contact_id = null where contact_id is not null and not exists (select 1 from public.contacts c where c.id = m.contact_id);
alter table public.email_messages add constraint email_messages_contact_id_fkey foreign key (contact_id) references public.contacts(id) on delete set null;
notify pgrst, 'reload schema';
