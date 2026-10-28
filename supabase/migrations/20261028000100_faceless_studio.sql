create extension if not exists pgcrypto;

create table if not exists public.series_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  series_name text not null default 'History in 60 Seconds',
  niche text not null default 'History',
  language text not null default 'English',
  voice_style text not null default 'Warm documentary',
  art_style text not null default 'Cinematic archival illustration',
  caption_style text not null default 'Bold, clean subtitles',
  music_style text not null default 'Subtle cinematic',
  effects_style text not null default 'Slow camera moves + soft transitions',
  aspect_ratio text not null default '9:16' check (aspect_ratio in ('9:16','16:9','1:1','4:5')),
  duration_seconds integer not null default 50 check (duration_seconds between 50 and 59),
  resolution text not null default '4k' check (resolution in ('1080p','4k')),
  daily_enabled boolean not null default true,
  timezone text not null default 'Asia/Kolkata',
  ready_by time not null default '19:00:00',
  monthly_budget_usd numeric(8,2) not null default 30.00 check (monthly_budget_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.episodes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_type text not null default 'manual' check (run_type in ('manual','daily')),
  scheduled_for date,
  topic text,
  title text,
  status text not null default 'draft' check (status in ('queued','researching','scripting','voiceover','music','artwork','rendering','ready','failed','budget_hold','draft')),
  progress integer not null default 0 check (progress between 0 and 100),
  progress_message text,
  script jsonb,
  sources jsonb not null default '[]'::jsonb,
  storage_path text,
  duration_seconds integer check (duration_seconds between 50 and 59),
  aspect_ratio text check (aspect_ratio in ('9:16','16:9','1:1','4:5')),
  resolution text,
  estimated_cost_usd numeric(8,3) not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create unique index if not exists episodes_one_daily_run_per_user_day
  on public.episodes(user_id, scheduled_for)
  where run_type = 'daily' and scheduled_for is not null;
create index if not exists episodes_user_created_idx on public.episodes(user_id, created_at desc);

alter table public.series_settings enable row level security;
alter table public.episodes enable row level security;

drop policy if exists "owners read own series" on public.series_settings;
create policy "owners read own series" on public.series_settings for select to authenticated using (auth.uid() = user_id);
drop policy if exists "owners insert own series" on public.series_settings;
create policy "owners insert own series" on public.series_settings for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "owners update own series" on public.series_settings;
create policy "owners update own series" on public.series_settings for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "owners read own episodes" on public.episodes;
create policy "owners read own episodes" on public.episodes for select to authenticated using (auth.uid() = user_id);
drop policy if exists "owners insert own episodes" on public.episodes;
create policy "owners insert own episodes" on public.episodes for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "owners update own episodes" on public.episodes;
create policy "owners update own episodes" on public.episodes for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "owners delete own episodes" on public.episodes;
create policy "owners delete own episodes" on public.episodes for delete to authenticated using (auth.uid() = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('daily-videos', 'daily-videos', false, 536870912, array['video/mp4'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "owners read own rendered videos" on storage.objects;
create policy "owners read own rendered videos" on storage.objects for select to authenticated
  using (bucket_id = 'daily-videos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "owners upload own rendered videos" on storage.objects;
create policy "owners upload own rendered videos" on storage.objects for insert to authenticated
  with check (bucket_id = 'daily-videos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "owners update own rendered videos" on storage.objects;
create policy "owners update own rendered videos" on storage.objects for update to authenticated
  using (bucket_id = 'daily-videos' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'daily-videos' and (storage.foldername(name))[1] = auth.uid()::text);
