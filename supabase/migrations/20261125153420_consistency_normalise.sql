-- A draft only counts as contradicting the facts sheet when at least one issue is quoted.
create or replace function private.normalise_consistency() returns trigger language plpgsql as $$
begin
  if new.consistency is not null and coalesce(jsonb_array_length(new.consistency->'issues'), 0) = 0 then
    new.consistency := jsonb_set(new.consistency, '{ok}', 'true'::jsonb);
  end if;
  return new;
end $$;
create trigger t_normalise_consistency before insert or update of consistency on public.approvals
  for each row execute function private.normalise_consistency();
update public.approvals set consistency = jsonb_set(consistency, '{ok}', 'true'::jsonb)
  where consistency is not null and coalesce(jsonb_array_length(consistency->'issues'), 0) = 0 and (consistency->>'ok')::boolean is false;
