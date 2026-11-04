-- Apply after update-23-leadership-visibility-and-prize-fulfillment.sql.
-- Adds an admin-only action to immediately send saved follow-up templates to current assignees.

create or replace function public.send_leadership_role_reminders()
returns jsonb
language plpgsql security definer set search_path = public, auth, net as $$
declare
  role_cfg public.leadership_role_email_settings;
  hub_settings public.leadership_hub_settings;
  mail_cfg public.notify_config;
  assignment record;
  role_template record;
  assigned_role_name text;
  local_date date := (now() at time zone 'America/New_York')::date;
  rotation_day int;
  current_week_start date;
  target_week_start date;
  resume_date date;
  meeting_week_start date;
  meeting_date_text text;
  resolved_subject text;
  resolved_body text;
  request_id bigint;
  request_error text;
  queued_count int := 0;
  assignment_count int := 0;
  failures text[] := array[]::text[];
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;

  select * into role_cfg from public.leadership_role_email_settings where id = 1;
  if not found then raise exception 'Student Leadership role email settings are missing.'; end if;
  if not role_cfg.enabled then raise exception 'Enable Student Leadership role emails before sending a manual reminder.'; end if;

  select * into hub_settings from public.leadership_hub_settings where id = 1;
  if not found then raise exception 'Student Leadership settings are missing.'; end if;
  rotation_day := hub_settings.rotation_weekday;
  current_week_start := public.leadership_rotation_week_start(
    (now() at time zone 'UTC')::date, rotation_day
  );
  target_week_start := current_week_start;

  if hub_settings.rotation_paused then
    if hub_settings.next_meeting_date is null then
      raise exception 'Role rotation is paused until a next meeting date is set.';
    end if;
    resume_date := hub_settings.next_meeting_date
      - coalesce(nullif(mod(extract(dow from hub_settings.next_meeting_date)::int - 4 + 7, 7), 0), 7);
    if local_date < resume_date then
      raise exception 'Role rotation is paused until %.', to_char(resume_date, 'FMMonth FMDD, YYYY');
    end if;
    if local_date <= hub_settings.next_meeting_date then
      meeting_week_start := public.leadership_rotation_week_start(
        hub_settings.next_meeting_date, rotation_day
      );
      if meeting_week_start > current_week_start then target_week_start := meeting_week_start; end if;
    end if;
  end if;

  select * into mail_cfg from public.notify_config where id = 1;
  if not found or coalesce(mail_cfg.webhook_url, '') = '' or coalesce(mail_cfg.secret, '') = '' then
    raise exception 'Configure the Apps Script URL and secret in Admin → Email alerts first.';
  end if;

  meeting_date_text := coalesce(
    to_char(hub_settings.next_meeting_date, 'FMMonth FMDD, YYYY'),
    'a date to be announced'
  );

  for assignment in
    select * from public.leadership_role_email_assignments(target_week_start)
  loop
    foreach assigned_role_name in array assignment.assigned_roles
    loop
      assignment_count := assignment_count + 1;
      select chart_role.id, chart_role.name,
             template.followup_subject, template.followup_body
        into role_template
        from public.leadership_chart_roles chart_role
        join public.leadership_role_email_templates template on template.role_id = chart_role.id
       where chart_role.name = assigned_role_name;
      if not found then
        failures := array_append(failures, assigned_role_name || ': no saved email template');
        continue;
      end if;

      resolved_subject := replace(role_template.followup_subject, '{{member_name}}', assignment.assigned_name);
      resolved_subject := replace(resolved_subject, '{{role_name}}', role_template.name);
      resolved_subject := replace(resolved_subject, '{{week_start}}', to_char(target_week_start, 'FMMonth FMDD, YYYY'));
      resolved_subject := replace(resolved_subject, '{{meeting_date}}', meeting_date_text);
      resolved_body := replace(role_template.followup_body, '{{member_name}}', assignment.assigned_name);
      resolved_body := replace(resolved_body, '{{role_name}}', role_template.name);
      resolved_body := replace(resolved_body, '{{week_start}}', to_char(target_week_start, 'FMMonth FMDD, YYYY'));
      resolved_body := replace(resolved_body, '{{meeting_date}}', meeting_date_text);

      request_id := null;
      request_error := null;
      begin
        select net.http_post(
          url := mail_cfg.webhook_url,
          body := jsonb_build_object(
            'secret', mail_cfg.secret,
            'to', jsonb_build_array(assignment.assigned_email),
            'subject', resolved_subject,
            'text', resolved_body
          ),
          headers := '{"Content-Type": "application/json"}'::jsonb
        ) into request_id;
      exception when others then
        request_error := sqlerrm;
      end;

      if request_id is null then
        failures := array_append(failures, assigned_role_name || ': ' || coalesce(request_error, 'email request could not be queued'));
      else
        queued_count := queued_count + 1;
      end if;
    end loop;
  end loop;

  if assignment_count = 0 then raise exception 'There are no current Student Leadership role assignments to remind.'; end if;
  return jsonb_build_object(
    'queued', queued_count,
    'failed', to_jsonb(failures),
    'week_start', target_week_start
  );
end $$;
revoke all on function public.send_leadership_role_reminders() from public, anon;
grant execute on function public.send_leadership_role_reminders() to authenticated;

notify pgrst, 'reload schema';
