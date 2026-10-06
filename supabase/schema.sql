-- =====================================================================
-- Naija Agro-Hustle — Supabase schema (verified leaderboards + cloud saves)
-- Run this in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run, and safe to run over the older v1 schema (it upgrades it).
--
-- Security model (no logins needed):
--  * Tables have Row Level Security ON with no policies, so the public
--    (anon/publishable) key can NOT read or write them directly.
--  * The public key can only READ the leaderboard and use cloud saves.
--  * Scores can ONLY be written by the `verify-run` Edge Function using the
--    service-role key. That function re-plays the player's recorded moves
--    with the real game rules and computes the score itself — the browser
--    never gets to say "my net worth is X".
-- =====================================================================

-- ---------- Tables ----------
create table if not exists public.scores (
  device_id  uuid        not null,
  sector     text        not null check (sector in ('crop', 'poultry', 'livestock')),
  name       text        not null check (char_length(name) between 1 and 28),
  profile    text        not null check (profile in ('alhaji', 'hustler')),
  net_worth  bigint      not null,
  day        int         not null check (day between 1 and 3650),
  won        boolean     not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (device_id, sector)
);
alter table public.scores add column if not exists verified boolean not null default false;
alter table public.scores add column if not exists rules int;
alter table public.scores add column if not exists cmds int;
create index if not exists scores_rank_idx on public.scores (net_worth desc, day asc) where verified;
create index if not exists scores_sector_rank_idx on public.scores (sector, net_worth desc, day asc) where verified;

-- One entry per device per Daily Challenge date. Everyone that day gets the same seed/sector/profile.
create table if not exists public.daily_scores (
  day        date        not null,
  device_id  uuid        not null,
  name       text        not null check (char_length(name) between 1 and 28),
  sector     text        not null check (sector in ('crop', 'poultry', 'livestock')),
  profile    text        not null check (profile in ('alhaji', 'hustler')),
  net_worth  bigint      not null,
  rules      int,
  cmds       int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (day, device_id)
);
create index if not exists daily_rank_idx on public.daily_scores (day, net_worth desc, created_at asc);

create table if not exists public.saves (
  code       text        primary key check (code ~ '^[A-Z2-9]{10}$'),
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

alter table public.scores       enable row level security;
alter table public.daily_scores enable row level security;
alter table public.saves        enable row level security;
revoke all on table public.scores       from anon, authenticated;
revoke all on table public.daily_scores from anon, authenticated;
revoke all on table public.saves        from anon, authenticated;

-- ---------- Remove the old unverified, client-callable submit function ----------
drop function if exists public.submit_score(uuid, text, text, text, bigint, int, boolean);
drop function if exists public.get_leaderboard(text, int, uuid);

-- ---------- Verified submit (service role only — called by the verify-run Edge Function) ----------
create or replace function public.submit_verified_score(
  p_device uuid, p_name text, p_sector text, p_profile text,
  p_net_worth bigint, p_day int, p_won boolean, p_rules int, p_cmds int
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 28);
begin
  if p_device is null then raise exception 'missing device'; end if;
  if v_name = '' then v_name := 'Anonymous Farmer'; end if;
  if p_sector not in ('crop', 'poultry', 'livestock') or p_profile not in ('alhaji', 'hustler') then raise exception 'invalid run'; end if;
  if p_day is null or p_day < 1 or p_day > 3650 then raise exception 'invalid day'; end if;

  insert into public.scores as s (device_id, sector, name, profile, net_worth, day, won, verified, rules, cmds)
  values (p_device, p_sector, v_name, p_profile, p_net_worth, p_day, coalesce(p_won, false), true, p_rules, p_cmds)
  on conflict (device_id, sector) do update
    set name = excluded.name, profile = excluded.profile, net_worth = excluded.net_worth, day = excluded.day,
        won = (s.verified and s.won) or excluded.won, verified = true, rules = excluded.rules, cmds = excluded.cmds, updated_at = now()
    -- an old unverified entry is always replaced; a verified one only by a better (or newly won) farm
    where not s.verified or excluded.net_worth > s.net_worth or (excluded.won and not s.won);
end $$;

create or replace function public.submit_daily_score(
  p_day date, p_device uuid, p_name text, p_sector text, p_profile text,
  p_net_worth bigint, p_rules int, p_cmds int
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text := left(btrim(regexp_replace(coalesce(p_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 28);
begin
  if p_day is null or p_device is null then raise exception 'invalid run'; end if;
  if v_name = '' then v_name := 'Anonymous Farmer'; end if;
  -- keep the best verified attempt per device per day
  insert into public.daily_scores as d (day, device_id, name, sector, profile, net_worth, rules, cmds)
  values (p_day, p_device, v_name, p_sector, p_profile, p_net_worth, p_rules, p_cmds)
  on conflict (day, device_id) do update
    set name = excluded.name, net_worth = excluded.net_worth, rules = excluded.rules, cmds = excluded.cmds, updated_at = now()
    where excluded.net_worth > d.net_worth;
end $$;

-- ---------- Leaderboard: read (public) ----------
-- p_mode 'free' = all-time verified farms (optionally per sector); 'daily' = the Daily Challenge for p_date.
create or replace function public.get_leaderboard(
  p_mode text default 'free', p_sector text default null, p_date date default null,
  p_limit int default 50, p_device uuid default null
) returns table (pos bigint, name text, sector text, profile text, net_worth bigint, day int, won boolean, is_me boolean)
language sql stable security definer set search_path = public as $$
  select * from (
    select rank() over (order by s.net_worth desc, s.day asc) as pos,
           s.name, s.sector, s.profile, s.net_worth, s.day, s.won,
           (p_device is not null and s.device_id = p_device) as is_me
    from public.scores s
    where coalesce(p_mode, 'free') = 'free' and s.verified and (p_sector is null or s.sector = p_sector)
    union all
    select rank() over (order by d.net_worth desc, d.created_at asc) as pos,
           d.name, d.sector, d.profile, d.net_worth, 10 as day, false as won,
           (p_device is not null and d.device_id = p_device) as is_me
    from public.daily_scores d
    where p_mode = 'daily' and d.day = coalesce(p_date, (now() at time zone 'Africa/Lagos')::date)
  ) x
  order by x.pos asc
  limit least(greatest(coalesce(p_limit, 50), 1), 100);
$$;

-- ---------- Cloud save: write (anyone holding the secret 10-char code can overwrite) ----------
-- Saves include the recorded moves, so a restored farm can still be verified for the leaderboard.
create or replace function public.cloud_save(p_code text, p_data jsonb) returns timestamptz
language plpgsql security definer set search_path = public as $$
begin
  if p_code is null or p_code !~ '^[A-Z2-9]{10}$' then raise exception 'invalid code'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or (p_data ->> 'v') is distinct from '1' then
    raise exception 'invalid save';
  end if;
  if pg_column_size(p_data) > 2097152 then raise exception 'save too large'; end if;
  insert into public.saves (code, data, updated_at) values (p_code, p_data, now())
  on conflict (code) do update set data = excluded.data, updated_at = now();
  return now();
end $$;

create or replace function public.cloud_load(p_code text) returns jsonb
language sql stable security definer set search_path = public as $$
  select data from public.saves where code = upper(btrim(coalesce(p_code, '')));
$$;

-- ---------- Permissions ----------
revoke all on function public.submit_verified_score(uuid, text, text, text, bigint, int, boolean, int, int) from public, anon, authenticated;
revoke all on function public.submit_daily_score(date, uuid, text, text, text, bigint, int, int) from public, anon, authenticated;
grant execute on function public.submit_verified_score(uuid, text, text, text, bigint, int, boolean, int, int) to service_role;
grant execute on function public.submit_daily_score(date, uuid, text, text, text, bigint, int, int) to service_role;

revoke all on function public.get_leaderboard(text, text, date, int, uuid) from public;
revoke all on function public.cloud_save(text, jsonb) from public;
revoke all on function public.cloud_load(text) from public;
grant execute on function public.get_leaderboard(text, text, date, int, uuid) to anon, authenticated;
grant execute on function public.cloud_save(text, jsonb) to anon, authenticated;
grant execute on function public.cloud_load(text) to anon, authenticated;

-- Optional housekeeping (run manually or schedule with pg_cron):
-- delete from public.saves where updated_at < now() - interval '180 days';
-- delete from public.daily_scores where day < current_date - 90;

notify pgrst, 'reload schema';
