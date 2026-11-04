-- Apply after update-25-leadership-empty-roles-and-meeting-date.sql.
-- Reapply the same-day guard and correct a meeting date already saved as today.

create or replace function public.move_same_day_leadership_meeting_to_wednesday()
returns trigger language plpgsql set search_path = public as $$
declare
  eastern_today date := (now() at time zone 'America/New_York')::date;
  days_until_wednesday int;
begin
  if new.next_meeting_date = eastern_today then
    days_until_wednesday := mod(3 - extract(dow from eastern_today)::int + 7, 7);
    if days_until_wednesday = 0 then days_until_wednesday := 7; end if;
    new.next_meeting_date := eastern_today + days_until_wednesday;
  end if;
  return new;
end $$;
revoke all on function public.move_same_day_leadership_meeting_to_wednesday() from public, anon, authenticated;

drop trigger if exists leadership_meeting_date_future_wednesday on public.leadership_hub_settings;
create trigger leadership_meeting_date_future_wednesday
before insert or update of next_meeting_date on public.leadership_hub_settings
for each row execute function public.move_same_day_leadership_meeting_to_wednesday();

update public.leadership_hub_settings
set next_meeting_date = next_meeting_date
  + case
      when mod(3 - extract(dow from next_meeting_date)::int + 7, 7) = 0 then 7
      else mod(3 - extract(dow from next_meeting_date)::int + 7, 7)
    end
where next_meeting_date = (now() at time zone 'America/New_York')::date;

notify pgrst, 'reload schema';
