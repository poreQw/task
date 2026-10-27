create table if not exists public.daily_logs (
  user_id uuid not null references auth.users (id) on delete cascade,
  log_date date not null,
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, log_date)
);

create or replace function public.set_daily_logs_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists daily_logs_set_updated_at on public.daily_logs;
create trigger daily_logs_set_updated_at
  before update on public.daily_logs
  for each row execute function public.set_daily_logs_updated_at();

alter table public.daily_logs enable row level security;

grant select, insert, update, delete on public.daily_logs to authenticated;

drop policy if exists "Users can read their own daily logs" on public.daily_logs;
create policy "Users can read their own daily logs"
  on public.daily_logs for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own daily logs" on public.daily_logs;
create policy "Users can create their own daily logs"
  on public.daily_logs for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own daily logs" on public.daily_logs;
create policy "Users can update their own daily logs"
  on public.daily_logs for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own daily logs" on public.daily_logs;
create policy "Users can delete their own daily logs"
  on public.daily_logs for delete
  to authenticated
  using ((select auth.uid()) = user_id);
