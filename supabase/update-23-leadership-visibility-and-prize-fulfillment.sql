-- Apply after update-22-student-directory-names.sql.
-- Adds Student Leadership section visibility controls and prize fulfillment tracking.

alter table public.leadership_hub_settings
  add column if not exists show_chat_reports boolean not null default true,
  add column if not exists show_prizes boolean not null default true;

alter table public.leadership_prize_claims
  add column if not exists fulfilled_by uuid references auth.users(id) on delete set null,
  add column if not exists fulfilled_at timestamptz;

alter table public.leadership_prize_claims
  drop constraint if exists leadership_prize_claims_status_check;
alter table public.leadership_prize_claims
  add constraint leadership_prize_claims_status_check
  check (status in ('pending', 'approved', 'rejected', 'fulfilled'));

alter table public.leadership_prize_claims
  drop constraint if exists leadership_prize_claims_check;
alter table public.leadership_prize_claims
  add constraint leadership_prize_claims_check check (
    (status in ('approved', 'rejected') and reviewed_at is not null)
    or (status = 'fulfilled' and reviewed_at is not null and fulfilled_at is not null)
    or status = 'pending'
  );

create or replace function public.claim_leadership_prize(p_prize_id uuid)
returns uuid language plpgsql security definer set search_path = public, auth as $$
declare
  caller uuid := auth.uid();
  caller_email text := lower(coalesce(auth.jwt()->>'email', ''));
  prize public.leadership_prizes;
  earned bigint;
  reserved bigint;
  claim_id uuid;
begin
  if caller is null or not public.can_view_leadership_hub() then
    raise exception 'Student Leadership access is disabled or not available for this account.';
  end if;
  perform 1 from auth.users where id = caller for update;
  select * into prize from public.leadership_prizes where id = p_prize_id and active for share;
  if not found then raise exception 'This prize is not available.'; end if;
  select coalesce(sum(points_awarded), 0) into earned
    from public.leadership_chat_reports where reporter_id = caller and status = 'approved';
  earned := earned + coalesce((
    select sum(points) from public.leadership_bonus_points
     where lower(member_email) = caller_email
  ), 0);
  select coalesce(sum(points_cost), 0) into reserved
    from public.leadership_prize_claims where user_id = caller and status in ('pending', 'approved', 'fulfilled');
  if earned - reserved < prize.points_cost then raise exception 'You do not have enough available points for this prize.'; end if;
  insert into public.leadership_prize_claims (user_id, prize_id, prize_name, points_cost)
  values (caller, prize.id, prize.name, prize.points_cost)
  returning id into claim_id;
  return claim_id;
end $$;
grant execute on function public.claim_leadership_prize(uuid) to authenticated;

create or replace function public.fulfill_leadership_prize_claim(p_claim_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  changed_id uuid;
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  update public.leadership_prize_claims
     set status = 'fulfilled', fulfilled_by = auth.uid(), fulfilled_at = now()
   where id = p_claim_id and status = 'approved'
  returning id into changed_id;
  if changed_id is null then raise exception 'This approved prize request is no longer available to fulfill.'; end if;
end $$;
revoke all on function public.fulfill_leadership_prize_claim(uuid) from public, anon;
grant execute on function public.fulfill_leadership_prize_claim(uuid) to authenticated;

notify pgrst, 'reload schema';
