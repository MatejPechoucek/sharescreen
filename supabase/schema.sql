create table if not exists public.rooms (
  id text primary key,
  creator_token_hash text not null,
  mode text not null check (mode in ('url', 'file')),
  source_url text,
  expires_at timestamptz not null,
  last_active_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.rooms enable row level security;
create index if not exists rooms_expiry_idx on public.rooms (expires_at, last_active_at);
-- Realtime is intentionally used as an ephemeral bus; no playback or media bytes are stored.
alter publication supabase_realtime add table public.rooms;
