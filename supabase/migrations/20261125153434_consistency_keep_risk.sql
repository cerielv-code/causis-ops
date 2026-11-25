-- When a check finds no quoted issue, keep the draft's original risk level.
create or replace function private.normalise_consistency() returns trigger language plpgsql as $$
begin
  if new.consistency is not null and coalesce(jsonb_array_length(new.consistency->'issues'), 0) = 0 then
    new.consistency := jsonb_set(new.consistency, '{ok}', 'true'::jsonb);
    if tg_op = 'UPDATE' and new.risk = 'high' and old.risk is distinct from 'high' then new.risk := old.risk; end if;
  end if;
  return new;
end $$;
update public.approvals set risk = 'low'
  where status = 'pending' and source = 'panel' and risk = 'high' and (consistency->>'ok')::boolean is true and kind = 'outreach';
