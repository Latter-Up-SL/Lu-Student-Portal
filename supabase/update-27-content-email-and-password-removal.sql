-- Apply after update-26-leadership-meeting-date-backfill.sql.
-- Adds opt-in release emails for announcements, videos, and photo challenges,
-- and removes the obsolete forced-password-change gate.

create extension if not exists pg_net;
create extension if not exists pg_cron;

alter table public.announcements
  add column if not exists email_opt_in boolean not null default false;
alter table public.videos
  add column if not exists email_opt_in boolean not null default false;
alter table public.themes
  add column if not exists email_opt_in boolean not null default false;

alter table public.notify_config
  add column if not exists announcement_email_subject text not null default 'New announcement: {{title}}',
  add column if not exists announcement_email_body text not null
    default E'A new announcement is available: {{title}}\n\n{{description}}\n\nRead it here: {{url}}',
  add column if not exists video_email_subject text not null default 'New video: {{title}}',
  add column if not exists video_email_body text not null
    default E'A new video is available: {{title}}\n\n{{description}}\n\nWatch it here: {{url}}',
  add column if not exists theme_email_subject text not null default 'New Photo Challenge: {{title}}',
  add column if not exists theme_email_body text not null
    default E'A new Photo Challenge starts {{start_date}}: {{title}}\n\n{{description}}\n\nJoin the challenge: {{url}}';

alter table public.notify_config
  drop constraint if exists notify_config_announcement_email_subject_check,
  drop constraint if exists notify_config_announcement_email_body_check,
  drop constraint if exists notify_config_video_email_subject_check,
  drop constraint if exists notify_config_video_email_body_check,
  drop constraint if exists notify_config_theme_email_subject_check,
  drop constraint if exists notify_config_theme_email_body_check;
alter table public.notify_config
  add constraint notify_config_announcement_email_subject_check
    check (length(trim(announcement_email_subject)) between 1 and 200),
  add constraint notify_config_announcement_email_body_check
    check (length(trim(announcement_email_body)) between 1 and 10000),
  add constraint notify_config_video_email_subject_check
    check (length(trim(video_email_subject)) between 1 and 200),
  add constraint notify_config_video_email_body_check
    check (length(trim(video_email_body)) between 1 and 10000),
  add constraint notify_config_theme_email_subject_check
    check (length(trim(theme_email_subject)) between 1 and 200),
  add constraint notify_config_theme_email_body_check
    check (length(trim(theme_email_body)) between 1 and 10000);

create table if not exists public.content_email_deliveries (
  id bigint generated always as identity primary key,
  content_type text not null check (content_type in ('announcement', 'video', 'theme')),
  content_id uuid not null,
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled')),
  request_id bigint,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  requested_at timestamptz,
  sent_at timestamptz,
  last_error text,
  unique (content_type, content_id)
);
create index if not exists content_email_deliveries_queue
  on public.content_email_deliveries (status, next_attempt_at);
alter table public.content_email_deliveries enable row level security;
drop policy if exists "content email deliveries admin read" on public.content_email_deliveries;
create policy "content email deliveries admin read" on public.content_email_deliveries
  for select to authenticated using (public.is_admin());
drop policy if exists "content email deliveries admin retry" on public.content_email_deliveries;
create policy "content email deliveries admin retry" on public.content_email_deliveries
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, update on public.content_email_deliveries to authenticated;

create or replace function public.is_lu() returns boolean
language sql stable as $$
  select lower(coalesce(auth.jwt()->>'email', '')) like '%@latterup.org'
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admins
     where lower(email) = lower(coalesce(auth.jwt()->>'email', ''))
  )
$$;

create or replace function public.is_leader() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.leadership
     where lower(email) = lower(coalesce(auth.jwt()->>'email', ''))
  )
$$;
grant execute on function public.is_lu() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_leader() to anon, authenticated;

update auth.users
   set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) - 'must_change_password',
       raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) - 'must_change_password'
 where lower(coalesce(raw_app_meta_data->>'must_change_password', 'false')) = 'true'
    or lower(coalesce(raw_user_meta_data->>'must_change_password', 'false')) = 'true';

drop function if exists public.list_students();
create function public.list_students()
returns table (email text, full_name text, created_at timestamptz, last_sign_in_at timestamptz,
               admin_role boolean, leader_role boolean)
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
           exists (select 1 from public.admins a where lower(a.email) = lower(u.email)),
           exists (select 1 from public.leadership l where lower(l.email) = lower(u.email))
      from auth.users u
      left join public.student_directory_names names on names.email = lower(u.email)
     order by lower(u.email);
end $$;
revoke all on function public.list_students() from public, anon;
grant execute on function public.list_students() to authenticated;

create or replace function public.process_content_release_emails()
returns void
language plpgsql security definer set search_path = public, net, auth as $$
declare
  cfg public.notify_config;
  delivery record;
  recipients text[];
  v_request_id bigint;
  response_status int;
  response_content text;
  resolved_subject text;
  resolved_body text;
  subject_template text;
  body_template text;
  content_url text;
  content_label text;
begin
  select * into cfg from public.notify_config where id = 1;

  for delivery in
    select d.id, d.attempts, r.status_code, r.content
      from public.content_email_deliveries d
      join net._http_response r on r.id = d.request_id
     where d.status = 'sending'
     for update of d skip locked
  loop
    response_status := delivery.status_code;
    response_content := coalesce(delivery.content, '');
    if response_status between 200 and 299
       and response_content ~ '"ok"[[:space:]]*:[[:space:]]*true' then
      update public.content_email_deliveries
         set status = 'sent', sent_at = now(), last_error = null, request_id = null
       where id = delivery.id;
    else
      update public.content_email_deliveries
         set status = case when delivery.attempts >= 3 then 'failed' else 'pending' end,
             next_attempt_at = now() + interval '5 minutes',
             last_error = left(format('Apps Script HTTP %s: %s', response_status, response_content), 2000),
             request_id = null
       where id = delivery.id;
    end if;
  end loop;

  insert into public.content_email_deliveries (content_type, content_id, payload)
  select 'announcement', a.id,
         jsonb_build_object(
           'title', a.title, 'description', coalesce(a.text, ''),
           'date', to_char(a.date, 'FMMonth FMDD, YYYY')
         )
    from public.announcements a
   where a.email_opt_in and a.publish_at <= now()
  on conflict (content_type, content_id) do nothing;

  insert into public.content_email_deliveries (content_type, content_id, payload)
  select 'video', v.id,
         jsonb_build_object(
           'title', v.title, 'description', coalesce(v.description, ''),
           'date', to_char(v.date, 'FMMonth FMDD, YYYY')
         )
    from public.videos v
   where v.email_opt_in and v.publish_at <= now()
  on conflict (content_type, content_id) do nothing;

  insert into public.content_email_deliveries (content_type, content_id, payload)
  select 'theme', t.id,
         jsonb_build_object(
           'title', t.title, 'description', coalesce(t.description, ''),
           'date', to_char(t.starts_at at time zone s.timezone, 'FMMonth FMDD, YYYY'),
           'start_date', to_char(t.starts_at at time zone s.timezone, 'FMMonth FMDD, YYYY'),
           'end_date', to_char(t.ends_at at time zone s.timezone, 'FMMonth FMDD, YYYY')
         )
    from public.themes t
    cross join public.settings s
   where t.email_opt_in and t.starts_at <= now() and s.id = 1
  on conflict (content_type, content_id) do nothing;

  update public.content_email_deliveries d
     set status = 'cancelled',
         last_error = 'Content was removed, rescheduled, or its email option was turned off.'
   where d.status = 'pending'
     and not (
       (d.content_type = 'announcement' and exists (
          select 1 from public.announcements a
           where a.id = d.content_id and a.email_opt_in and a.publish_at <= now()
       ))
       or (d.content_type = 'video' and exists (
          select 1 from public.videos v
           where v.id = d.content_id and v.email_opt_in and v.publish_at <= now()
       ))
       or (d.content_type = 'theme' and exists (
          select 1 from public.themes t
           where t.id = d.content_id and t.email_opt_in and t.starts_at <= now()
       ))
     );

  if not coalesce(cfg.enabled, false) or coalesce(cfg.webhook_url, '') = '' then
    return;
  end if;

  select array_agg(lower(u.email) order by lower(u.email))
    into recipients
    from auth.users u
   where u.email_confirmed_at is not null
     and not coalesce(u.is_anonymous, false)
     and lower(coalesce(u.email, '')) ~ '^[^@]+@latterup\.org$';
  if recipients is null or cardinality(recipients) = 0 then return; end if;

  for delivery in
    select d.id, d.content_type, d.payload, d.attempts
      from public.content_email_deliveries d
     where d.status = 'pending'
       and d.attempts < 3
       and d.next_attempt_at <= now()
     order by d.next_attempt_at, d.id
     limit 25
     for update skip locked
  loop
    case delivery.content_type
      when 'announcement' then
        subject_template := cfg.announcement_email_subject;
        body_template := cfg.announcement_email_body;
        content_label := 'Announcement';
        content_url := rtrim(coalesce(cfg.site_url, ''), '/') || '/announcements.html';
      when 'video' then
        subject_template := cfg.video_email_subject;
        body_template := cfg.video_email_body;
        content_label := 'Video';
        content_url := rtrim(coalesce(cfg.site_url, ''), '/') || '/videos.html';
      else
        subject_template := cfg.theme_email_subject;
        body_template := cfg.theme_email_body;
        content_label := 'Photo Challenge';
        content_url := rtrim(coalesce(cfg.site_url, ''), '/') || '/photos.html';
    end case;

    resolved_subject := coalesce(subject_template, '');
    resolved_subject := replace(resolved_subject, '{{title}}', coalesce(delivery.payload->>'title', ''));
    resolved_subject := replace(resolved_subject, '{{description}}', coalesce(delivery.payload->>'description', ''));
    resolved_subject := replace(resolved_subject, '{{date}}', coalesce(delivery.payload->>'date', ''));
    resolved_subject := replace(resolved_subject, '{{start_date}}', coalesce(delivery.payload->>'start_date', ''));
    resolved_subject := replace(resolved_subject, '{{end_date}}', coalesce(delivery.payload->>'end_date', ''));
    resolved_subject := replace(resolved_subject, '{{url}}', content_url);
    resolved_subject := replace(resolved_subject, '{{type}}', content_label);

    resolved_body := coalesce(body_template, '');
    resolved_body := replace(resolved_body, '{{title}}', coalesce(delivery.payload->>'title', ''));
    resolved_body := replace(resolved_body, '{{description}}', coalesce(delivery.payload->>'description', ''));
    resolved_body := replace(resolved_body, '{{date}}', coalesce(delivery.payload->>'date', ''));
    resolved_body := replace(resolved_body, '{{start_date}}', coalesce(delivery.payload->>'start_date', ''));
    resolved_body := replace(resolved_body, '{{end_date}}', coalesce(delivery.payload->>'end_date', ''));
    resolved_body := replace(resolved_body, '{{url}}', content_url);
    resolved_body := replace(resolved_body, '{{type}}', content_label);

    select net.http_post(
      url := cfg.webhook_url,
      body := jsonb_build_object(
        'secret', cfg.secret,
        'to', to_jsonb(recipients),
        'subject', left(resolved_subject, 200),
        'text', resolved_body
      ),
      headers := '{"Content-Type": "application/json"}'::jsonb
    ) into v_request_id;

    if v_request_id is null then
      update public.content_email_deliveries
         set status = case when attempts + 1 >= 3 then 'failed' else 'pending' end,
             attempts = attempts + 1,
             next_attempt_at = now() + interval '5 minutes',
             last_error = 'The email request could not be queued.'
       where id = delivery.id;
    else
      update public.content_email_deliveries
         set status = 'sending', request_id = v_request_id,
             requested_at = now(), attempts = attempts + 1, last_error = null
       where id = delivery.id;
    end if;
  end loop;
end $$;

revoke all on function public.process_content_release_emails() from public, anon, authenticated;

do $$
declare
  existing_job record;
begin
  for existing_job in select jobid from cron.job where jobname = 'process-content-release-emails'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
  perform cron.schedule(
    'process-content-release-emails',
    '*/5 * * * *',
    'select public.process_content_release_emails()'
  );
end $$;

notify pgrst, 'reload schema';
