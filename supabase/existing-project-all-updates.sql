-- Latter UP existing-project migration bundle
-- Run this once in the Supabase SQL Editor for a project that already has
-- supabase/setup.sql applied. This bundles updates 2 and 4 through 8 in order.
-- Do NOT use on a new project; use setup.sql followed by the individual updates.
-- Before running, deploy the change-own-password Edge Function as documented in README.md.
-- This bundle does not deploy Edge Functions or configure Supabase Auth settings.


-- =====================================================================
-- update-2-names.sql
-- =====================================================================

-- Run once in the SQL editor. Makes the name shown on photos come from a field
-- that students cannot edit themselves (app_metadata, set by the import script).
create or replace function public.submissions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare cap int;
begin
  if not public.is_admin() then
    new.user_id := auth.uid();
    new.status := 'pending';
    new.submitted_by := coalesce(
      nullif(auth.jwt()->'app_metadata'->>'full_name',''),
      split_part(auth.jwt()->>'email','@',1));
    select max_photos_per_theme into cap from public.settings where id = 1;
    if (select count(*) from public.submissions
          where theme_id = new.theme_id and user_id = new.user_id) >= cap then
      raise exception 'You can submit up to % photos per theme.', cap;
    end if;
  end if;
  return new;
end $$;


-- =====================================================================
-- update-4-portal-customization.sql
-- =====================================================================

-- Latter UP portal customization migration
-- Run in the Supabase SQL Editor after the existing setup scripts. Safe to rerun.
alter table public.settings
  add column if not exists portal_banner jsonb not null default '{"enabled":false,"text":"","link_text":"Learn more","link_url":""}'::jsonb,
  add column if not exists portal_home_sections jsonb not null default '[{"id":"hero","label":"Welcome header","enabled":true},{"id":"links","label":"Quick-link tiles","enabled":true},{"id":"announcements","label":"Latest announcements","enabled":true},{"id":"videos","label":"Latest videos","enabled":true},{"id":"schedule-embed","label":"Your Schedule embed","enabled":true},{"id":"faq","label":"Frequently asked questions","enabled":true},{"id":"photo-challenge","label":"Photo Challenge shortcut","enabled":true}]'::jsonb,
  add column if not exists portal_tiles jsonb not null default '[{"title":"Calendar","description":"Co-op events, activities, and important dates.","url":"https://calendar.google.com","cta":"Open Google Calendar","icon":"calendar","secondary_text":"Open Family Sync","secondary_url":"https://familysync.latterup.org/"},{"title":"Google Drive","description":"Your files, docs, slides, and sheets.","url":"https://drive.google.com","cta":"Open Google Drive","icon":"drive"},{"title":"Google Chat","description":"Message teachers, classmates, and friends.","url":"https://mail.google.com/chat","cta":"Open Chat","icon":"chat"},{"title":"Email","description":"Check your email and message teachers and friends.","url":"https://mail.google.com","cta":"Open Email","icon":"email"},{"title":"Google Classroom","description":"View assignments, materials, and due dates.","url":"https://classroom.google.com","cta":"Open Classroom","icon":"classroom"},{"title":"Trackers","description":"Your Success Circle and Homeroom to-do and focus lists.","url":"https://pathwaysandpossibilities.netlify.app/tracker","cta":"Open Tracker","icon":"compass"},{"title":"Feedback","description":"Give feedback on anything LU.","url":"https://docs.google.com/forms/d/e/1FAIpQLSfwVwucRiMsnTMPcP-LV25BrLkVb_dBFtxDyX0xMIMqguZisQ/viewform","cta":"Open Form","icon":"document"}]'::jsonb;

-- Ensure the single settings row exists (without overwriting any existing settings).
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- Ask PostgREST/Supabase API to refresh its schema cache immediately.
notify pgrst, 'reload schema';


-- =====================================================================
-- update-5a-leadership-team.sql
-- =====================================================================

-- Run once in the Supabase SQL Editor (paste the code itself, not the file name).
-- Adds a "Leadership team" role between students and admins.
--   Leadership CAN: add announcements, videos and photo themes; approve/reject photos.
--   Leadership CANNOT: edit or delete anything, import photos, change settings,
--                      manage students/admins, or edit the site layout. (Admins keep full control.)

create table if not exists public.leadership (email text primary key);   -- lowercase @latterup.org emails
alter table public.leadership enable row level security;
drop policy if exists "leadership admin manage" on public.leadership;
create policy "leadership admin manage" on public.leadership for all
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.is_leader() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.leadership
                 where lower(email) = lower(coalesce(auth.jwt()->>'email', '')))
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select case when public.is_admin() then 'admin'
              when public.is_leader() then 'leader'
              else 'student' end
$$;

grant execute on function public.is_leader() to anon, authenticated;
grant execute on function public.my_role()   to anon, authenticated;

-- Announcements: leaders can see everything (including scheduled) and add new ones.
drop policy if exists "announcements leader read" on public.announcements;
create policy "announcements leader read" on public.announcements for select using (public.is_leader());
drop policy if exists "announcements leader add" on public.announcements;
create policy "announcements leader add" on public.announcements for insert with check (public.is_leader());

-- Videos: same.
drop policy if exists "videos leader read" on public.videos;
create policy "videos leader read" on public.videos for select using (public.is_leader());
drop policy if exists "videos leader add" on public.videos;
create policy "videos leader add" on public.videos for insert with check (public.is_leader());

-- Photo themes: leaders can see all (including upcoming) and add new ones. No edit, no delete.
drop policy if exists "themes leader read" on public.themes;
create policy "themes leader read" on public.themes for select using (public.is_leader());
drop policy if exists "themes leader add" on public.themes;
create policy "themes leader add" on public.themes for insert with check (public.is_leader());

-- Photos: leaders can see every photo and change its status (approve/reject) — nothing else.
drop policy if exists "photos leader read" on public.submissions;
create policy "photos leader read" on public.submissions for select using (public.is_leader());
drop policy if exists "photos leader review" on public.submissions;
create policy "photos leader review" on public.submissions for update
  using (public.is_leader()) with check (public.is_leader());

create or replace function public.submissions_leader_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() or not public.is_leader() then return new; end if;
  if new.theme_id    is distinct from old.theme_id
  or new.user_id     is distinct from old.user_id
  or new.submitted_by is distinct from old.submitted_by
  or new.caption     is distinct from old.caption
  or new.image_path  is distinct from old.image_path then
    raise exception 'Leadership can only approve or reject photos.';
  end if;
  return new;
end $$;

drop trigger if exists submissions_leader_guard on public.submissions;
create trigger submissions_leader_guard before update on public.submissions
  for each row execute function public.submissions_leader_guard();

-- Files: leaders can upload flyers/videos for the announcements and videos they add (no replace/delete).
drop policy if exists "media leader upload" on storage.objects;
create policy "media leader upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.is_leader());


-- =====================================================================
-- update-5b-email-alerts.sql
-- =====================================================================

-- Run AFTER update-5a (paste the code itself, not the file name).
-- Emails the Leadership team + Admins when new photos are waiting for approval.
-- One email at most every 5 minutes, no matter how many photos came in.
-- If the two "create extension" lines fail, switch on "pg_net" and "pg_cron" in
-- Dashboard -> Database -> Extensions, then run this file again.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists public.notify_config (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  webhook_url text,            -- Google Apps Script web app address
  secret text,                 -- shared secret code checked by the script
  site_url text,               -- e.g. https://your-site.netlify.app (for the link in the email)
  last_request_id bigint,
  last_sent_at timestamptz,
  last_status int
);
insert into public.notify_config (id) values (1) on conflict do nothing;
alter table public.notify_config enable row level security;
drop policy if exists "notify admin" on public.notify_config;
create policy "notify admin" on public.notify_config for all
  using (public.is_admin()) with check (public.is_admin());

alter table public.submissions add column if not exists notified_at timestamptz;
update public.submissions set notified_at = now() where notified_at is null;  -- don't announce old photos

create or replace function public.notify_new_photos(force_test boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare
  cfg public.notify_config;
  n int; recipients text[]; lines text; subj text; txt text; req bigint;
begin
  select * into cfg from public.notify_config where id = 1;

  if cfg.last_request_id is not null then      -- remember how the previous email request went
    update public.notify_config
       set last_status = (select status_code from net._http_response where id = cfg.last_request_id)
     where id = 1;
  end if;

  if coalesce(cfg.webhook_url, '') = '' or (not cfg.enabled and not force_test) then
    return 'Email alerts are off or not set up yet.';
  end if;

  select array_agg(distinct lower(email)) into recipients
    from (select email from public.leadership union select email from public.admins) r;
  if recipients is null then return 'There is nobody to email yet.'; end if;

  select count(*) into n from public.submissions where status = 'pending' and notified_at is null;
  if n = 0 and not force_test then return 'Nothing new.'; end if;

  select string_agg('• ' || s.submitted_by || ' — ' || t.title, E'\n' order by s.created_at) into lines
    from (select * from public.submissions
           where status = 'pending' and notified_at is null order by created_at limit 30) s
    join public.themes t on t.id = s.theme_id;

  if force_test then
    subj := 'Test email from the Latter UP portal';
    txt  := 'This is a test. Email alerts for new photos are working.';
  else
    subj := n || ' new photo' || case when n = 1 then '' else 's' end || ' waiting for approval';
    txt  := n || ' new photo' || case when n = 1 then ' is' else 's are' end
            || E' waiting for approval:\n\n' || coalesce(lines, '')
            || case when n > 30 then E'\n…and ' || (n - 30) || ' more' else '' end
            || E'\n\nReview them here: ' || coalesce(nullif(cfg.site_url, ''), '') || '/admin.html';
  end if;

  select net.http_post(
           url := cfg.webhook_url,
           body := jsonb_build_object('secret', cfg.secret, 'to', to_jsonb(recipients), 'subject', subj, 'text', txt),
           headers := '{"Content-Type": "application/json"}'::jsonb
         ) into req;

  update public.notify_config set last_request_id = req, last_sent_at = now() where id = 1;
  if not force_test then
    update public.submissions set notified_at = now() where status = 'pending' and notified_at is null;
  end if;
  return case when force_test then 'Test email requested.' else 'Alert sent for ' || n || ' photo(s).' end;
end $$;

revoke all on function public.notify_new_photos(boolean) from public, anon, authenticated;

create or replace function public.send_test_alert() returns text
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return public.notify_new_photos(true);
end $$;
grant execute on function public.send_test_alert() to authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'notify-new-photos';
select cron.schedule('notify-new-photos', '*/5 * * * *', 'select public.notify_new_photos()');


-- =====================================================================
-- update-6-students-list.sql
-- =====================================================================

-- Run once in the Supabase SQL Editor (paste the code itself, not the file name).
-- Lets admins (only) see the list of everyone with a login, for Admin -> Students.
create or replace function public.list_students()
returns table (email text, full_name text, created_at timestamptz, last_sign_in_at timestamptz,
               must_change_password boolean, admin_role boolean, leader_role boolean)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return query
    select u.email::text,
           coalesce(u.raw_app_meta_data->>'full_name', '')::text,
           u.created_at,
           u.last_sign_in_at,
           coalesce((u.raw_user_meta_data->>'must_change_password')::boolean, false),
           exists (select 1 from public.admins a where lower(a.email) = lower(u.email)),
           exists (select 1 from public.leadership l where lower(l.email) = lower(u.email))
      from auth.users u
     order by lower(u.email);
end $$;
revoke all on function public.list_students() from public, anon;
grant execute on function public.list_students() to authenticated;


-- =====================================================================
-- update-7-bug-fixes.sql
-- =====================================================================

-- Apply after setup.sql, update-5a-leadership-team.sql, update-5b-email-alerts.sql,
-- and update-6-students-list.sql.
-- Adds announcement/video scheduling and the opt-in anonymous photo page.

alter table public.settings
  add column if not exists public_photo_page boolean not null default false;

alter table public.announcements
  add column if not exists publish_at timestamptz;
update public.announcements set publish_at = coalesce(publish_at, created_at, now());
alter table public.announcements alter column publish_at set default now();
alter table public.announcements alter column publish_at set not null;

alter table public.videos
  add column if not exists publish_at timestamptz;
update public.videos set publish_at = coalesce(publish_at, created_at, now());
alter table public.videos alter column publish_at set default now();
alter table public.videos alter column publish_at set not null;

create or replace function public.public_photo_page_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select s.public_photo_page from public.settings s where s.id = 1), false)
$$;
grant execute on function public.public_photo_page_enabled() to anon, authenticated;

drop function if exists public.public_config();
create or replace function public.public_config() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'enabled', coalesce(s.public_photo_page, false),
    'max', coalesce(s.max_photos_per_theme, 5)
  )
  from public.settings s
  where s.id = 1
$$;
grant execute on function public.public_config() to anon, authenticated;

drop policy if exists "themes read" on public.themes;
create policy "themes read" on public.themes for select using (
  public.is_admin()
  or (public.is_lu() and starts_at <= now())
  or (
    starts_at <= now()
    and public.public_photo_page_enabled()
  )
);

drop policy if exists "public approved photos read" on public.submissions;
create policy "public approved photos read" on public.submissions for select using (
  status = 'approved'
  and exists (
    select 1 from public.themes t
    where t.id = theme_id and t.ends_at <= now()
  )
  and public.public_photo_page_enabled()
);

drop policy if exists "public photo submissions" on public.submissions;
drop policy if exists "anonymous photo submissions" on public.submissions;
create policy "anonymous photo submissions" on public.submissions for insert to authenticated with check (
  auth.jwt()->>'is_anonymous' = 'true'
  and user_id = auth.uid()
  and status = 'pending'
  and length(btrim(submitted_by)) between 1 and 60
  and image_path like (auth.uid()::text || '/%')
  and exists (
    select 1 from public.themes t
    where t.id = theme_id
      and now() >= t.starts_at
      and now() < t.ends_at
  )
  and public.public_photo_page_enabled()
);

drop policy if exists "public photo uploads" on storage.objects;
drop policy if exists "anonymous photo uploads" on storage.objects;
create policy "anonymous photo uploads" on storage.objects for insert to authenticated with check (
  bucket_id = 'photos'
  and auth.jwt()->>'is_anonymous' = 'true'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.public_photo_page_enabled()
);

drop policy if exists "public approved photo files" on storage.objects;
create policy "public approved photo files" on storage.objects for select to authenticated using (
  bucket_id = 'photos'
  and exists (
    select 1 from public.submissions p
    join public.themes t on t.id = p.theme_id
    where p.image_path = name
      and p.status = 'approved'
      and t.ends_at <= now()
  )
  and public.public_photo_page_enabled()
);

create or replace function public.submissions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cap int;
  public_enabled boolean;
begin
  if public.is_admin() then return new; end if;

  if auth.jwt()->>'is_anonymous' = 'true' then
    select s.public_photo_page, s.max_photos_per_theme
      into public_enabled, cap
      from public.settings s where s.id = 1;
    if not coalesce(public_enabled, false) then
      raise exception 'Public photo submissions are closed.';
    end if;
    if length(btrim(new.submitted_by)) not between 1 and 60
       or new.image_path not like (auth.uid()::text || '/%') then
      raise exception 'A name and a valid visitor photo upload are required.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(new.theme_id::text || ':' || auth.uid()::text, 0));
    if (select count(*) from public.submissions
          where theme_id = new.theme_id and user_id = auth.uid()) >= cap then
      raise exception 'You can submit up to % photos per visitor session for this theme.', cap;
    end if;
    new.user_id := auth.uid();
    new.status := 'pending';
    new.submitted_by := btrim(new.submitted_by);
    return new;
  end if;

  new.user_id := auth.uid();
  new.status := 'pending';
  new.submitted_by := coalesce(
    nullif(auth.jwt()->'user_metadata'->>'full_name',''),
    nullif(auth.jwt()->'user_metadata'->>'name',''),
    split_part(auth.jwt()->>'email','@',1));
  select max_photos_per_theme into cap from public.settings where id = 1;
  perform pg_advisory_xact_lock(hashtextextended(new.theme_id::text || ':' || auth.uid()::text, 0));
  if (select count(*) from public.submissions
        where theme_id = new.theme_id and user_id = new.user_id) >= cap then
    raise exception 'You can submit up to % photos per theme.', cap;
  end if;
  return new;
end $$;

alter table public.notify_config
  add column if not exists last_batch_created_before timestamptz,
  add column if not exists last_request_test boolean not null default false;

create or replace function public.notify_new_photos(force_test boolean default false) returns text
language plpgsql security definer set search_path = public as $$
declare
  cfg public.notify_config;
  n int;
  recipients text[];
  lines text;
  subj text;
  txt text;
  req bigint;
  response_status int;
  response_content text;
  response_found boolean := false;
begin
  select * into cfg from public.notify_config where id = 1;

  if cfg.last_request_id is not null then
    select r.status_code, r.content
      into response_status, response_content
      from net._http_response r where r.id = cfg.last_request_id;
    response_found := found;

    if not response_found then
      return 'The previous email request is still processing.';
    end if;

    if not cfg.last_request_test
       and response_status between 200 and 299
       and response_content ~ '"ok"[[:space:]]*:[[:space:]]*true' then
      update public.submissions
         set notified_at = now()
       where status = 'pending'
         and notified_at is null
         and created_at <= cfg.last_batch_created_before;
    end if;

    update public.notify_config
       set last_status = response_status,
           last_request_id = null,
           last_batch_created_before = null,
           last_request_test = false
     where id = 1;
  end if;

  if coalesce(cfg.webhook_url, '') = '' or (not cfg.enabled and not force_test) then
    return 'Email alerts are off or not set up yet.';
  end if;

  select array_agg(distinct lower(email)) into recipients
    from (select email from public.leadership union select email from public.admins) r;
  if recipients is null then return 'There is nobody to email yet.'; end if;

  select count(*) into n
    from public.submissions
   where status = 'pending' and notified_at is null;
  if n = 0 and not force_test then return 'Nothing new.'; end if;

  if force_test then
    subj := 'Test email from the Latter UP portal';
    txt := 'This is a test. Email alerts for new photos are working.';
  else
    select string_agg('• ' || s.submitted_by || ' — ' || t.title, E'\n' order by s.created_at)
      into lines
      from (
        select * from public.submissions
         where status = 'pending' and notified_at is null
         order by created_at limit 30
      ) s
      join public.themes t on t.id = s.theme_id;
    subj := n || ' new photo' || case when n = 1 then '' else 's' end || ' waiting for approval';
    txt := n || ' new photo' || case when n = 1 then ' is' else 's are' end
      || E' waiting for approval:\n\n' || coalesce(lines, '')
      || case when n > 30 then E'\n…and ' || (n - 30) || ' more' else '' end
      || E'\n\nReview them here: ' || coalesce(nullif(cfg.site_url, ''), '') || '/admin.html';
  end if;

  select net.http_post(
    url := cfg.webhook_url,
    body := jsonb_build_object('secret', cfg.secret, 'to', to_jsonb(recipients), 'subject', subj, 'text', txt),
    headers := '{"Content-Type": "application/json"}'::jsonb
  ) into req;

  if req is null then return 'The email request could not be queued; pending photos will be retried.'; end if;

  update public.notify_config
     set last_request_id = req,
         last_sent_at = now(),
         last_batch_created_before = case when force_test then null else now() end,
         last_request_test = force_test
   where id = 1;
  return case when force_test then 'Test email queued.' else 'Alert queued for ' || n || ' photo(s).' end;
end $$;

create or replace function public.list_students()
returns table (email text, full_name text, created_at timestamptz, last_sign_in_at timestamptz,
               must_change_password boolean, admin_role boolean, leader_role boolean)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return query
    select u.email::text,
           coalesce(u.raw_app_meta_data->>'full_name', '')::text,
           u.created_at,
           u.last_sign_in_at,
           lower(coalesce(u.raw_user_meta_data->>'must_change_password', 'false')) = 'true',
           exists (select 1 from public.admins a where lower(a.email) = lower(u.email)),
           exists (select 1 from public.leadership l where lower(l.email) = lower(u.email))
      from auth.users u
     order by lower(u.email);
end $$;
revoke all on function public.list_students() from public, anon;
grant execute on function public.list_students() to authenticated;

notify pgrst, 'reload schema';


-- =====================================================================
-- update-8-security-and-data-fixes.sql
-- =====================================================================

-- Apply after update-7-bug-fixes.sql.
-- Closes the remaining RLS, scheduled-content, YouTube, and metadata gaps.
-- Deploy the change-own-password Edge Function before running this migration.
-- If this migration was run first, restore access with:
-- update auth.users
--    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) - 'must_change_password'
--  where lower(coalesce(raw_app_meta_data->>'must_change_password', 'false')) = 'true';

drop policy if exists "admins admin manage" on public.admins;
create policy "admins admin manage" on public.admins for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.is_lu() returns boolean
language sql stable as $$
  select lower(coalesce(auth.jwt()->>'email','')) like '%@latterup.org'
    and coalesce(auth.jwt()->'app_metadata'->>'must_change_password', 'false') <> 'true'
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt()->'app_metadata'->>'must_change_password', 'false') <> 'true'
    and exists (
      select 1 from public.admins
      where lower(email) = lower(coalesce(auth.jwt()->>'email',''))
    )
$$;
grant execute on function public.is_lu() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;

create or replace function public.is_leader() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt()->'app_metadata'->>'must_change_password', 'false') <> 'true'
    and exists (
      select 1 from public.leadership
      where lower(email) = lower(coalesce(auth.jwt()->>'email', ''))
    )
$$;
grant execute on function public.is_leader() to anon, authenticated;

drop policy if exists "announcements read" on public.announcements;
drop policy if exists "announcements leader read" on public.announcements;
create policy "announcements read" on public.announcements for select to authenticated
  using (public.is_lu() and publish_at <= now());
create policy "announcements leader read" on public.announcements for select to authenticated
  using (public.is_leader());

drop policy if exists "videos read" on public.videos;
drop policy if exists "videos leader read" on public.videos;
create policy "videos read" on public.videos for select to authenticated
  using (public.is_lu() and publish_at <= now());
create policy "videos leader read" on public.videos for select to authenticated
  using (public.is_leader());

drop policy if exists "media view" on storage.objects;
create policy "media view" on storage.objects for select to authenticated using (
  bucket_id = 'media'
  and (
    public.is_admin()
    or public.is_leader()
    or exists (
      select 1 from public.announcements a
      where a.pdf_path = name and a.publish_at <= now() and public.is_lu()
    )
    or exists (
      select 1 from public.videos v
      where v.video_path = name and v.publish_at <= now() and public.is_lu()
    )
    or exists (
      select 1 from public.themes t
      where t.video_path = name and t.ends_at <= now() and public.is_lu()
    )
  )
);

drop policy if exists "photos insert" on public.submissions;
create policy "photos insert" on public.submissions for insert to authenticated with check (
  public.is_lu()
  and user_id = auth.uid()
  and image_path like (auth.uid()::text || '/%')
  and exists (
    select 1 from public.themes t
    where t.id = theme_id and now() >= t.starts_at and now() < t.ends_at
  )
);

drop policy if exists "photos read" on public.submissions;
create policy "photos read" on public.submissions for select using (
  public.is_admin()
  or (public.is_lu() and user_id = auth.uid())
  or (auth.jwt()->>'is_anonymous' = 'true' and user_id = auth.uid())
  or (
    public.is_lu()
    and status = 'approved'
    and exists (select 1 from public.themes t where t.id = theme_id and t.ends_at <= now())
  )
);

drop policy if exists "photos view allowed" on storage.objects;
create policy "photos view allowed" on storage.objects for select to authenticated using (
  bucket_id = 'photos'
  and (
    public.is_admin()
    or (public.is_lu() and (storage.foldername(name))[1] = auth.uid()::text)
    or (
      auth.jwt()->>'is_anonymous' = 'true'
      and public.public_photo_page_enabled()
      and (storage.foldername(name))[1] = 'public'
      and (storage.foldername(name))[2] = auth.uid()::text
    )
    or exists (select 1 from public.submissions s where s.image_path = name)
  )
);

drop policy if exists "photos delete own folder" on storage.objects;
create policy "photos delete own folder" on storage.objects for delete to authenticated using (
  bucket_id = 'photos'
  and (
    public.is_admin()
    or (
      public.is_lu()
      and (storage.foldername(name))[1] = auth.uid()::text
      and exists (
        select 1 from public.themes t
        where t.id::text = (storage.foldername(name))[2]
          and now() >= t.starts_at and now() < t.ends_at
      )
    )
    or (
      (
        public.is_lu()
        or (
          auth.jwt()->>'is_anonymous' = 'true'
          and public.public_photo_page_enabled()
        )
      )
      and (storage.foldername(name))[1] = auth.uid()::text
      and array_length(storage.foldername(name), 1) = 1
    )
    or (
      auth.jwt()->>'is_anonymous' = 'true'
      and public.public_photo_page_enabled()
      and (storage.foldername(name))[1] = 'public'
      and (storage.foldername(name))[2] = auth.uid()::text
      and exists (
        select 1 from public.themes t
        where t.id::text = (storage.foldername(name))[3]
          and now() >= t.starts_at and now() < t.ends_at
      )
    )
  )
);

create or replace function public.can_upload_photo(theme_path text, public_mode boolean)
returns boolean
language plpgsql security definer set search_path = public, storage as $$
declare
  cap int;
  submissions_count int;
  folder_prefix text;
begin
  if auth.uid() is null or theme_path is null then return false; end if;
  if public_mode then
    if coalesce(auth.jwt()->>'is_anonymous', 'false') <> 'true' or not public.public_photo_page_enabled() then return false; end if;
    folder_prefix := 'public/' || auth.uid()::text || '/' || theme_path || '/';
  else
    if not public.is_lu() or auth.jwt()->>'is_anonymous' = 'true' then return false; end if;
    folder_prefix := auth.uid()::text || '/' || theme_path || '/';
  end if;

  if not exists (
    select 1 from public.themes t
    where t.id::text = theme_path and now() >= t.starts_at and now() < t.ends_at
  ) then return false; end if;

  perform pg_advisory_xact_lock(hashtextextended(folder_prefix, 0));
  select s.max_photos_per_theme into cap from public.settings s where s.id = 1;
  select count(*) into submissions_count
    from public.submissions s
   where s.user_id = auth.uid() and s.theme_id::text = theme_path;
  return coalesce(submissions_count, 0) < coalesce(cap, 0);
end $$;
revoke all on function public.can_upload_photo(text, boolean) from public, anon, authenticated;
grant execute on function public.can_upload_photo(text, boolean) to authenticated;

drop policy if exists "anonymous photo submissions" on public.submissions;
create policy "anonymous photo submissions" on public.submissions for insert to authenticated with check (
  auth.jwt()->>'is_anonymous' = 'true'
  and user_id = auth.uid()
  and status = 'pending'
  and length(btrim(submitted_by)) between 1 and 60
  and image_path like ('public/' || auth.uid()::text || '/%')
  and exists (
    select 1 from public.themes t
    where t.id = theme_id and now() >= t.starts_at and now() < t.ends_at
  )
  and public.public_photo_page_enabled()
);

drop policy if exists "anonymous photo uploads" on storage.objects;
create policy "anonymous photo uploads" on storage.objects for insert to authenticated with check (
  bucket_id = 'photos'
  and auth.jwt()->>'is_anonymous' = 'true'
  and (storage.foldername(name))[1] = 'public'
  and (storage.foldername(name))[2] = auth.uid()::text
  and public.can_upload_photo((storage.foldername(name))[3], true)
);

drop policy if exists "photos upload own folder" on storage.objects;
create policy "photos upload own folder" on storage.objects for insert to authenticated with check (
  bucket_id = 'photos'
  and public.is_lu()
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.can_upload_photo((storage.foldername(name))[2], false)
);

create or replace function public.submissions_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cap int;
  public_enabled boolean;
  display_name text;
begin
  if public.is_admin() and new.user_id is null then
    new.submitted_by := regexp_replace(btrim(new.submitted_by), '[[:cntrl:]]+', ' ', 'g');
    return new;
  end if;

  if auth.jwt()->>'is_anonymous' = 'true' then
    select s.public_photo_page, s.max_photos_per_theme
      into public_enabled, cap
      from public.settings s where s.id = 1;
    if not coalesce(public_enabled, false) then
      raise exception 'Public photo submissions are closed.';
    end if;
    if length(btrim(new.submitted_by)) not between 1 and 60
       or new.image_path not like ('public/' || auth.uid()::text || '/%') then
      raise exception 'A name and a valid visitor photo upload are required.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(new.theme_id::text || ':' || auth.uid()::text, 0));
    if (select count(*) from public.submissions
          where theme_id = new.theme_id and user_id = auth.uid()) >= cap then
      raise exception 'You can submit up to % photos per visitor session for this theme.', cap;
    end if;
    new.user_id := auth.uid();
    new.status := 'pending';
    new.submitted_by := regexp_replace(btrim(new.submitted_by), '[[:cntrl:]]+', ' ', 'g');
    return new;
  end if;

  new.user_id := auth.uid();
  new.status := 'pending';
  display_name := coalesce(
    nullif(auth.jwt()->'app_metadata'->>'full_name',''),
    split_part(auth.jwt()->>'email','@',1));
  new.submitted_by := regexp_replace(btrim(display_name), '[[:cntrl:]]+', ' ', 'g');
  select max_photos_per_theme into cap from public.settings where id = 1;
  perform pg_advisory_xact_lock(hashtextextended(new.theme_id::text || ':' || auth.uid()::text, 0));
  if (select count(*) from public.submissions
        where theme_id = new.theme_id and user_id = new.user_id) >= cap then
    raise exception 'You can submit up to % photos per theme.', cap;
  end if;
  return new;
end $$;

create or replace function public.next_theme_window()
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql stable as $$
declare
  s public.settings;
  st timestamptz;
begin
  select * into s from public.settings where id = 1;
  select greatest(coalesce(max(t.ends_at), now()), now()) into st from public.themes t;
  return query select
    st,
    ((st at time zone s.timezone) + make_interval(days => s.theme_length_days)) at time zone s.timezone;
end $$;
grant execute on function public.next_theme_window() to authenticated;

do $$
begin
  if exists (
    select 1 from public.settings s
    where not exists (select 1 from pg_timezone_names z where z.name = s.timezone)
  ) then
    raise notice 'An invalid settings.timezone was replaced with the setup default America/Denver.';
    update public.settings s
       set timezone = 'America/Denver'
     where not exists (select 1 from pg_timezone_names z where z.name = s.timezone);
  end if;
end $$;

create or replace function public.validate_settings_timezone() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Unknown time zone: %', new.timezone;
  end if;
  return new;
end $$;
drop trigger if exists validate_settings_timezone on public.settings;
create trigger validate_settings_timezone before insert or update of timezone on public.settings
  for each row execute function public.validate_settings_timezone();

create or replace function public.portal_public_config() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'portal_banner', s.portal_banner,
    'portal_tiles', s.portal_tiles,
    'portal_home_sections', s.portal_home_sections
  )
  from public.settings s where s.id = 1
$$;
grant execute on function public.portal_public_config() to anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.videos'::regclass and conname = 'videos_youtube_id_format'
  ) then
    alter table public.videos add constraint videos_youtube_id_format
      check (youtube_id is null or youtube_id ~ '^[A-Za-z0-9_-]{11}$') not valid;
  end if;
end $$;

create or replace function public.list_students()
returns table (email text, full_name text, created_at timestamptz, last_sign_in_at timestamptz,
               must_change_password boolean, admin_role boolean, leader_role boolean)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return query
    select u.email::text,
           coalesce(u.raw_app_meta_data->>'full_name', '')::text,
           u.created_at,
           u.last_sign_in_at,
           lower(coalesce(u.raw_app_meta_data->>'must_change_password',
                          u.raw_user_meta_data->>'must_change_password', 'false')) = 'true',
           exists (select 1 from public.admins a where lower(a.email) = lower(u.email)),
           exists (select 1 from public.leadership l where lower(l.email) = lower(u.email))
      from auth.users u
     order by lower(u.email);
end $$;
revoke all on function public.list_students() from public, anon;
grant execute on function public.list_students() to authenticated;

update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
       || jsonb_build_object('must_change_password', true)
 where lower(coalesce(raw_user_meta_data->>'must_change_password', 'false')) = 'true'
   and lower(coalesce(raw_app_meta_data->>'must_change_password', 'false')) <> 'true';

notify pgrst, 'reload schema';

-- =====================================================================
-- update-9-google-drive-videos.sql
-- =====================================================================

alter table public.videos
  add column if not exists google_drive_id text;

alter table public.videos drop constraint if exists videos_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.videos'::regclass and conname = 'videos_video_source_required'
  ) then
    alter table public.videos add constraint videos_video_source_required
      check (youtube_id is not null or google_drive_id is not null or video_path is not null) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.videos'::regclass and conname = 'videos_google_drive_id_format'
  ) then
    alter table public.videos add constraint videos_google_drive_id_format
      check (google_drive_id is null or google_drive_id ~ '^[A-Za-z0-9_-]{10,}$') not valid;
  end if;
end $$;

notify pgrst, 'reload schema';
