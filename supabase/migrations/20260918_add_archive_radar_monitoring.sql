create table if not exists public.monitoring_targets (
  id uuid primary key default gen_random_uuid(),
  branch_id text null references public.research_branches(id) on update cascade on delete set null,
  name text not null,
  target_type text not null default 'website_page_change',
  source_url text not null,
  matcher jsonb not null default '{"type":"patterns","patterns":[],"complete_when":"all"}'::jsonb,
  status text not null default 'waiting' check (status in ('waiting','partial','found','error','paused')),
  enabled boolean not null default true,
  check_interval_hours integer not null default 24 check (check_interval_hours between 1 and 8760),
  next_check_at timestamptz null default now(),
  last_checked_at timestamptz null,
  last_http_status integer null,
  last_content_hash text null,
  last_match jsonb not null default '[]'::jsonb,
  found_at timestamptz null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.monitoring_checks (
  id bigint generated always as identity primary key,
  target_id uuid not null references public.monitoring_targets(id) on delete cascade,
  checked_at timestamptz not null default now(),
  http_status integer null,
  success boolean not null default false,
  content_hash text null,
  matched_patterns jsonb not null default '[]'::jsonb,
  error text null
);

create table if not exists public.monitoring_hits (
  id bigint generated always as identity primary key,
  target_id uuid not null references public.monitoring_targets(id) on delete cascade,
  detected_at timestamptz not null default now(),
  old_status text null,
  new_status text not null,
  new_matches jsonb not null default '[]'::jsonb,
  snapshot jsonb not null default '{}'::jsonb
);

create index if not exists monitoring_targets_due_idx
  on public.monitoring_targets (enabled, next_check_at)
  where enabled = true and status <> 'found';

create index if not exists monitoring_checks_target_checked_idx
  on public.monitoring_checks (target_id, checked_at desc);

create index if not exists monitoring_hits_target_detected_idx
  on public.monitoring_hits (target_id, detected_at desc);

alter table public.monitoring_targets enable row level security;
alter table public.monitoring_checks enable row level security;
alter table public.monitoring_hits enable row level security;

revoke all on public.monitoring_targets from anon, authenticated;
revoke all on public.monitoring_checks from anon, authenticated;
revoke all on public.monitoring_hits from anon, authenticated;

grant select, insert, update, delete on public.monitoring_targets to service_role;
grant select, insert, update, delete on public.monitoring_checks to service_role;
grant select, insert, update, delete on public.monitoring_hits to service_role;
grant usage, select on sequence public.monitoring_checks_id_seq to service_role;
grant usage, select on sequence public.monitoring_hits_id_seq to service_role;

insert into public.monitoring_targets (
  branch_id, name, target_type, source_url, matcher, status, enabled,
  check_interval_hours, notes
)
select
  'makovy',
  'ГАКО: фонд Р-1355, описи 25–36',
  'archive_digitization',
  'https://kosarchive.ru/archive/el_zal/',
  jsonb_build_object(
    'type','patterns',
    'complete_when','all',
    'patterns', jsonb_build_array(
      'Фонд Р-1355, Опись 25',
      'Фонд Р-1355, Опись 26',
      'Фонд Р-1355, Опись 27',
      'Фонд Р-1355, Опись 28',
      'Фонд Р-1355, Опись 29',
      'Фонд Р-1355, Опись 30',
      'Фонд Р-1355, Опись 31',
      'Фонд Р-1355, Опись 32',
      'Фонд Р-1355, Опись 33',
      'Фонд Р-1355, Опись 34',
      'Фонд Р-1355, Опись 35',
      'Фонд Р-1355, Опись 36'
    )
  ),
  'waiting',
  true,
  24,
  'Официальная страница ГАКО сообщает, что в 2026 году планируется оцифровать описи 25–36 фонда Р-1355. Мониторинг должен фиксировать появление каждой новой описи.'
where not exists (
  select 1 from public.monitoring_targets
  where source_url = 'https://kosarchive.ru/archive/el_zal/'
    and name = 'ГАКО: фонд Р-1355, описи 25–36'
);
