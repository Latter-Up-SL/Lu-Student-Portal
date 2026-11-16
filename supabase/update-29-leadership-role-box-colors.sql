-- Apply after update-28-leadership-role-descriptions.sql.
-- Adds an admin setting for highlighting Student Leadership role boxes.

alter table public.leadership_hub_settings
  add column if not exists role_box_colors_enabled boolean not null default true;
