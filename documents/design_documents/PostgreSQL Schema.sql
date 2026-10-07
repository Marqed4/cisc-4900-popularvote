-- ============================================================
-- PopularVote schema (CISC 4900 / v4900)
-- Paste this into the Supabase SQL editor on a fresh project.
--
-- The Flask backend uses the service_role key, which skips row level security.
-- The browser only has the anon key, so RLS is on and the browser can only touch
-- what the frontend actually uses:
--   sessions          read 5 public columns (Sidebar session history)
--   user_sessions     own rows only (signed-in users)
--   user_submissions  own rows only (signed-in users)
--   submissions       backend only (ciphertext JSON for encrypted sessions)
--   clusters          backend only
-- ============================================================

create table if not exists sessions (
  code text primary key,
  phase text not null default 'OPEN',
  tags text[] not null default '{}'::text[],
  title text,
  description text,
  host_notes text,
  expansion_round integer not null default 0,
  curators jsonb not null default '[]'::jsonb,
  submissions_at_last_cluster integer not null default 0,
  encrypted boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  session_code text not null references sessions(code) on delete cascade,
  -- plaintext, or '{"ciphertext": "...", "nonce": "..."}' for encrypted sessions
  content text not null,
  participant_answer text,
  is_curator boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists clusters (
  id uuid primary key default gen_random_uuid(),
  session_code text not null references sessions(code) on delete cascade,
  representative_query text,
  submission_count integer not null default 0,
  questions jsonb not null default '[]'::jsonb,
  answer text,
  upvote_count integer not null default 0,
  previewed_questions jsonb not null default '[]'::jsonb,
  selected_questions jsonb not null default '[]'::jsonb,
  contextual_facts jsonb not null default '[]'::jsonb,
  participant_answers jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- Signed-in users only. user_id comes from Supabase Auth.
create table if not exists user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_code text not null,
  role text,
  dismissed boolean not null default false,
  saved_at timestamptz not null default now(),
  unique (user_id, session_code)
);

create table if not exists user_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_code text not null,
  submission_id uuid,
  content text,
  submitted_at timestamptz not null default now(),
  unique (user_id, submission_id)
);

-- Indexes for the lookups the backend and frontend actually run
create index if not exists submissions_session_code_idx on submissions (session_code);
create index if not exists clusters_session_code_idx on clusters (session_code, created_at);
create index if not exists user_submissions_lookup_idx on user_submissions (user_id, session_code);
create index if not exists sessions_phase_idx on sessions (phase);

-- ============================================================
-- Row level security
-- ============================================================
alter table sessions enable row level security;
alter table submissions enable row level security;
alter table clusters enable row level security;
alter table user_sessions enable row level security;
alter table user_submissions enable row level security;

-- Take everything away from the browser roles, then add back only what's needed
revoke all on sessions, submissions, clusters, user_sessions, user_submissions from anon, authenticated;

grant all on sessions, submissions, clusters, user_sessions, user_submissions to service_role;

-- sessions: anyone can read just these columns (never host_notes, curators or the encrypted flag)
grant select (code, phase, tags, title, created_at) on sessions to anon, authenticated;
drop policy if exists "sessions public read" on sessions;
create policy "sessions public read" on sessions
  for select to anon, authenticated using (true);

-- user_sessions: a signed-in user only gets their own rows
grant select, insert, update, delete on user_sessions to authenticated;
drop policy if exists "user_sessions own rows" on user_sessions;
create policy "user_sessions own rows" on user_sessions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- user_submissions: same
grant select, insert, update, delete on user_submissions to authenticated;
drop policy if exists "user_submissions own rows" on user_submissions;
create policy "user_submissions own rows" on user_submissions
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- submissions and clusters: RLS is on with no policies, so only service_role can touch them.
