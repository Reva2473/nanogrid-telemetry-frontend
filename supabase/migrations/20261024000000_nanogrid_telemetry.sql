-- Migration: 20261024000000_nanogrid_telemetry.sql
-- Nanogrid Dual-Node Telemetry Architecture Schema

-- =============================================================================
-- 1. Table: public.node_latest
-- Stores the single most recent telemetry packet per physical node (node 1 & 2)
-- =============================================================================
create table if not exists public.node_latest (
    node smallint primary key check (node in (1, 2)),
    uptime_s integer not null check (uptime_s >= 0),
    src text not null check (src in ('NONE', 'PV', 'BATTERY')),
    tie text not null check (tie in ('NONE', 'EXPORT', 'IMPORT')),
    soc double precision not null check (soc >= 0 and soc <= 100),
    vbat double precision not null,
    ibat double precision not null,
    vpv double precision not null,
    ipv double precision not null,
    vbus double precision not null,
    ibus double precision not null,
    pv_ok boolean not null,
    lockout boolean not null,
    import_bus_ok boolean not null,
    rssi integer not null,
    fw text not null,
    received_at timestamptz not null default now()
);

comment on table public.node_latest is 'Current latest operational snapshot for Nanogrid Node 1 and Node 2';

-- =============================================================================
-- 2. Table: public.node_history
-- Stores downsampled historical telemetry for trending and analytics (30s sampling, 24h retention)
-- =============================================================================
create table if not exists public.node_history (
    id bigint generated always as identity primary key,
    node smallint not null check (node in (1, 2)),
    uptime_s integer not null check (uptime_s >= 0),
    src text not null check (src in ('NONE', 'PV', 'BATTERY')),
    tie text not null check (tie in ('NONE', 'EXPORT', 'IMPORT')),
    soc double precision not null check (soc >= 0 and soc <= 100),
    vbat double precision not null,
    ibat double precision not null,
    vpv double precision not null,
    ipv double precision not null,
    vbus double precision not null,
    ibus double precision not null,
    pv_ok boolean not null,
    lockout boolean not null,
    import_bus_ok boolean not null,
    rssi integer not null,
    fw text not null,
    received_at timestamptz not null default now()
);

comment on table public.node_history is 'Historical downsampled telemetry time series for Nanogrid nodes';

-- =============================================================================
-- 3. Indexes for fast range queries and per-node historical slices
-- =============================================================================
create index if not exists idx_node_history_node_received_at 
    on public.node_history (node, received_at desc);

create index if not exists idx_node_history_received_at 
    on public.node_history (received_at desc);

-- =============================================================================
-- 4. Row Level Security (RLS) Configuration
-- Strictly read-only for public anon and authenticated users
-- Writes/deletes permitted only via service_role in Supabase Edge Function
-- =============================================================================
alter table public.node_latest enable row level security;
alter table public.node_history enable row level security;

-- Drop existing policies if re-running
drop policy if exists "Allow public read access to node_latest" on public.node_latest;
create policy "Allow public read access to node_latest"
    on public.node_latest
    for select
    to anon, authenticated
    using (true);

drop policy if exists "Allow public read access to node_history" on public.node_history;
create policy "Allow public read access to node_history"
    on public.node_history
    for select
    to anon, authenticated
    using (true);

-- Ensure replica identity is FULL so Realtime updates provide full record payloads
alter table public.node_latest replica identity full;

-- =============================================================================
-- 5. Realtime Publication Setup
-- Add node_latest to supabase_realtime publication for instant UI WebSocket streaming
-- =============================================================================
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables 
      where pubname = 'supabase_realtime' 
        and schemaname = 'public' 
        and tablename = 'node_latest'
    ) then
      alter publication supabase_realtime add table public.node_latest;
    end if;
  end if;
end $$;
