-- Apply after update-24-send-leadership-role-reminders.sql.
-- Supports unassigned Student Leadership roles and moves same-day meeting dates
-- to the next Wednesday in Eastern time.

alter table public.leadership_role_overrides
  add column if not exists is_unassigned boolean not null default false;
alter table public.leadership_role_overrides
  alter column member_email drop not null;
alter table public.leadership_role_overrides
  drop constraint if exists leadership_role_overrides_assignment_check;
alter table public.leadership_role_overrides
  add constraint leadership_role_overrides_assignment_check
  check (
    (is_unassigned and member_email is null)
    or (not is_unassigned and member_email is not null)
  );

drop function if exists public.set_leadership_role_override(date, uuid, text, boolean);
create function public.set_leadership_role_override(
  p_week_start date,
  p_role_id uuid,
  p_member_email text,
  p_unassigned boolean
)
returns void
language plpgsql security definer set search_path = public, auth as $$
declare
  normalized_email text := lower(trim(coalesce(p_member_email, '')));
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if not public.leadership_rotation_week_is_editable(p_week_start) then
    raise exception 'Manual role assignments only apply to the current rotation week or the upcoming paused rotation.';
  end if;
  if not exists (select 1 from public.leadership_chart_roles where id = p_role_id) then
    raise exception 'That Student Leadership role no longer exists.';
  end if;

  if p_unassigned then
    insert into public.leadership_role_overrides
      (week_start, role_id, member_email, is_unassigned, created_by)
    values (p_week_start, p_role_id, null, true, auth.uid())
    on conflict (week_start, role_id) do update
      set member_email = null,
          is_unassigned = true,
          created_by = auth.uid(),
          created_at = now();
    return;
  end if;

  if normalized_email = '' then
    delete from public.leadership_role_overrides
     where week_start = p_week_start and role_id = p_role_id;
    return;
  end if;
  if not exists (select 1 from public.leadership_chart_members where email = normalized_email) then
    raise exception 'That person is not on the Student Leadership roster.';
  end if;
  if exists (
    select 1 from public.leadership_role_overrides
     where week_start = p_week_start
       and member_email = normalized_email
       and role_id <> p_role_id
  ) then
    raise exception 'That person is already manually assigned to another role this week.';
  end if;

  insert into public.leadership_role_overrides
    (week_start, role_id, member_email, is_unassigned, created_by)
  values (p_week_start, p_role_id, normalized_email, false, auth.uid())
  on conflict (week_start, role_id) do update
    set member_email = excluded.member_email,
        is_unassigned = false,
        created_by = excluded.created_by,
        created_at = now();
end $$;
revoke all on function public.set_leadership_role_override(date, uuid, text, boolean) from public, anon;
grant execute on function public.set_leadership_role_override(date, uuid, text, boolean) to authenticated;

create or replace function public.set_leadership_role_override(
  p_week_start date,
  p_role_id uuid,
  p_member_email text
)
returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  perform public.set_leadership_role_override(p_week_start, p_role_id, p_member_email, false);
end $$;
revoke all on function public.set_leadership_role_override(date, uuid, text) from public, anon;
grant execute on function public.set_leadership_role_override(date, uuid, text) to authenticated;

drop function if exists public.add_leadership_chart_role(text);
create function public.add_leadership_chart_role(p_name text, p_assign_all_members boolean default true)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  new_role_id uuid;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 80 then
    raise exception 'Role names must be between 1 and 80 characters.';
  end if;
  insert into public.leadership_chart_roles (name, sort_order)
  values (trim(p_name), coalesce((select max(sort_order) from public.leadership_chart_roles), 0) + 1)
  returning id into new_role_id;
  if coalesce(p_assign_all_members, true) then
    insert into public.leadership_member_roles (member_email, role_id)
    select email, new_role_id from public.leadership_chart_members
    on conflict (member_email, role_id) do nothing;
  end if;
  return new_role_id;
end $$;
revoke all on function public.add_leadership_chart_role(text, boolean) from public, anon;
grant execute on function public.add_leadership_chart_role(text, boolean) to authenticated;

create or replace function public.leadership_role_email_assignments(p_week_start date)
returns table (assigned_email text, assigned_name text, assigned_roles text[])
language plpgsql stable security definer set search_path = public as $$
declare
  rotation_day int;
  first_rotation date;
  week_index int;
  role_position int := 0;
  role_row record;
  pinned_email text;
  pinned_unassigned boolean;
  candidates text[];
  candidate_names text[];
  candidate_count int;
  start_index int;
  candidate_index int;
  candidate_offset int;
  chosen_email text;
  chosen_name text;
  result_emails text[] := '{}'::text[];
  result_names text[] := '{}'::text[];
  result_roles jsonb[] := '{}'::jsonb[];
  result_index int;
  output_index int;
begin
  select rotation_weekday into rotation_day
    from public.leadership_hub_settings where id = 1;
  if rotation_day is null then raise exception 'Student Leadership rotation settings are missing.'; end if;

  first_rotation := date '2024-01-07' + rotation_day;
  week_index := case when p_week_start < first_rotation then 0
    else floor((p_week_start - first_rotation)::numeric / 7)::int end;

  for role_row in
    select id, name from public.leadership_chart_roles order by sort_order, name
  loop
    role_position := role_position + 1;
    chosen_email := null;
    chosen_name := null;
    pinned_email := null;
    pinned_unassigned := false;
    select lower(member_email), is_unassigned into pinned_email, pinned_unassigned
      from public.leadership_role_overrides
     where week_start = p_week_start and role_id = role_row.id;
    if pinned_unassigned then continue; end if;
    if pinned_email is not null then
      select lower(email), display_name into chosen_email, chosen_name
        from public.leadership_chart_members
       where lower(email) = pinned_email;
    end if;

    if chosen_email is null then
      select array_agg(lower(member.email) order by member.sort_order, member.display_name),
             array_agg(member.display_name order by member.sort_order, member.display_name)
        into candidates, candidate_names
        from public.leadership_chart_members member
        join public.leadership_member_roles assignment on assignment.member_email = member.email
       where member.in_cycle
         and assignment.role_id = role_row.id
         and not exists (
           select 1 from public.leadership_rotation_exclusions exclusion
            where exclusion.week_start = p_week_start
              and lower(exclusion.member_email) = lower(member.email)
         );
      candidate_count := coalesce(cardinality(candidates), 0);
      if candidate_count = 0 then continue; end if;
      start_index := mod(week_index + role_position - 1, candidate_count) + 1;
      for candidate_offset in 0..candidate_count - 1 loop
        candidate_index := mod(start_index - 1 + candidate_offset, candidate_count) + 1;
        if not (candidates[candidate_index] = any(result_emails)) then
          chosen_email := candidates[candidate_index];
          chosen_name := candidate_names[candidate_index];
          exit;
        end if;
      end loop;
      if chosen_email is null then
        chosen_email := candidates[start_index];
        chosen_name := candidate_names[start_index];
      end if;
    end if;

    result_index := array_position(result_emails, chosen_email);
    if result_index is null then
      result_emails := array_append(result_emails, chosen_email);
      result_names := array_append(result_names, chosen_name);
      result_roles := array_append(result_roles, jsonb_build_array(role_row.name));
    else
      result_roles[result_index] := result_roles[result_index] || jsonb_build_array(role_row.name);
    end if;
  end loop;

  for output_index in 1..coalesce(cardinality(result_emails), 0) loop
    assigned_email := result_emails[output_index];
    assigned_name := result_names[output_index];
    select array_agg(role_name) into assigned_roles
      from jsonb_array_elements_text(result_roles[output_index]) as role_names(role_name);
    return next;
  end loop;
end $$;
revoke all on function public.leadership_role_email_assignments(date) from public, anon, authenticated;

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

notify pgrst, 'reload schema';
