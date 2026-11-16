-- Apply after update-27-content-email-and-password-removal.sql.
-- Adds editable descriptions to the Student Leadership chart roles.

alter table public.leadership_chart_roles
  add column if not exists description text not null default '';
