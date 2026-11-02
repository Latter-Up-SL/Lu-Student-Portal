-- Run after update-21-leadership-meeting-dates.sql.
-- Lets admins import first/last names from a private Google Sheets CSV export.

create table if not exists public.student_directory_names (
  email text primary key,
  first_name text not null check (length(trim(first_name)) between 1 and 100),
  last_name text not null check (length(trim(last_name)) between 1 and 100),
  updated_at timestamptz not null default now(),
  check (email = lower(trim(email)))
);

alter table public.student_directory_names enable row level security;
revoke all on public.student_directory_names from public, anon, authenticated;

create or replace function public.import_student_directory_names(p_students jsonb)
returns integer
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  if jsonb_typeof(p_students) is distinct from 'array' then
    raise exception 'Student import must be a JSON array.';
  end if;
  if jsonb_array_length(p_students) < 1
     or jsonb_array_length(p_students) > 5000 then
    raise exception 'Import between 1 and 5000 student rows.';
  end if;

  if exists (
    select 1
      from jsonb_to_recordset(p_students) as student(email text, first_name text, last_name text)
     where nullif(trim(student.email), '') is null
        or length(trim(student.email)) > 320
        or trim(student.email) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
        or nullif(trim(student.first_name), '') is null
        or length(trim(student.first_name)) > 100
        or nullif(trim(student.last_name), '') is null
        or length(trim(student.last_name)) > 100
  ) then
    raise exception 'Each row needs a valid email address and first and last names (up to 100 characters each).';
  end if;

  if exists (
    select lower(trim(student.email))
      from jsonb_to_recordset(p_students) as student(email text, first_name text, last_name text)
     group by lower(trim(student.email))
    having count(*) > 1
  ) then
    raise exception 'The import contains duplicate email addresses.';
  end if;

  insert into public.student_directory_names (email, first_name, last_name, updated_at)
  select lower(trim(student.email)), trim(student.first_name), trim(student.last_name), now()
    from jsonb_to_recordset(p_students) as student(email text, first_name text, last_name text)
  on conflict (email) do update
    set first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = excluded.updated_at;

  update public.leadership_chart_members members
     set display_name = trim(names.first_name || ' ' || names.last_name)
    from public.student_directory_names names
    join jsonb_to_recordset(p_students) as imported(email text, first_name text, last_name text)
      on lower(trim(imported.email)) = names.email
   where lower(members.email) = names.email;

  update auth.users users
     set raw_app_meta_data = coalesce(users.raw_app_meta_data, '{}'::jsonb)
       || jsonb_build_object('full_name', trim(names.first_name || ' ' || names.last_name))
    from public.student_directory_names names
    join jsonb_to_recordset(p_students) as imported(email text, first_name text, last_name text)
      on lower(trim(imported.email)) = names.email
   where lower(users.email) = names.email;

  return jsonb_array_length(p_students);
end $$;
revoke all on function public.import_student_directory_names(jsonb) from public, anon;
grant execute on function public.import_student_directory_names(jsonb) to authenticated;

create or replace function public.apply_student_directory_name()
returns trigger
language plpgsql security definer set search_path = public as $$
declare directory_name text;
begin
  select trim(names.first_name || ' ' || names.last_name)
    into directory_name
    from public.student_directory_names names
   where names.email = lower(trim(new.email));

  if directory_name is not null then
    new.raw_app_meta_data := coalesce(new.raw_app_meta_data, '{}'::jsonb)
      || jsonb_build_object('full_name', directory_name);
  end if;
  return new;
end $$;
revoke all on function public.apply_student_directory_name() from public, anon, authenticated;

drop trigger if exists student_directory_name_on_auth_user on auth.users;
create trigger student_directory_name_on_auth_user
before insert or update of email on auth.users
for each row execute function public.apply_student_directory_name();

create or replace function public.sync_leadership_chart_member()
returns trigger language plpgsql security definer set search_path = public as $$
declare directory_name text;
begin
  if tg_op = 'DELETE' then
    delete from public.leadership_chart_members where email = old.email;
    return old;
  end if;

  select trim(names.first_name || ' ' || names.last_name)
    into directory_name
    from public.student_directory_names names
   where names.email = lower(trim(new.email));

  insert into public.leadership_chart_members (email, display_name)
  values (
    new.email,
    coalesce(directory_name, initcap(replace(split_part(new.email, '@', 1), '.', ' ')))
  )
  on conflict (email) do nothing;
  insert into public.leadership_member_roles (member_email, role_id)
  select new.email, id from public.leadership_chart_roles
  on conflict (member_email, role_id) do nothing;
  return new;
end $$;

create or replace function public.list_students()
returns table (email text, full_name text, created_at timestamptz, last_sign_in_at timestamptz,
               must_change_password boolean, admin_role boolean, leader_role boolean)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return query
    select u.email::text,
           coalesce(
             nullif(trim(names.first_name || ' ' || names.last_name), ''),
             nullif(u.raw_app_meta_data->>'full_name', ''),
             ''
           )::text,
           u.created_at,
           u.last_sign_in_at,
           lower(coalesce(u.raw_app_meta_data->>'must_change_password',
                          u.raw_user_meta_data->>'must_change_password', 'false')) = 'true',
           exists (select 1 from public.admins a where lower(a.email) = lower(u.email)),
           exists (select 1 from public.leadership l where lower(l.email) = lower(u.email))
      from auth.users u
      left join public.student_directory_names names on names.email = lower(u.email)
     order by lower(u.email);
end $$;
revoke all on function public.list_students() from public, anon;
grant execute on function public.list_students() to authenticated;

notify pgrst, 'reload schema';
