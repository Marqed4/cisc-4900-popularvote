-- PopularVote schema. Paste into the Supabase SQL editor on a fresh project.
-- Upgrading an existing database? Run src/backend/database/migrations/2026-11-26_privacy_mode.sql instead.
--
-- The backend uses the service_role key, which skips row level security. The browser has only the
-- anon key, so RLS is on and the browser can reach just:
--   sessions                         6 public columns (session history and privacy badge)
--   user_sessions, user_submissions  a signed-in user's own rows
-- Everything else is backend only.
--
-- sessions.privacy_mode:
--   standard   the server can read questions, so Gemini can group them and suggest answers
--   encrypted  end to end; the host's browser hands the key to each participant
--   passcode   end to end; the key comes from a code the host shares and is never stored

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
  privacy_mode text not null default 'standard'
    check (privacy_mode in ('standard', 'encrypted', 'passcode')),
  -- passcode rooms only: a known phrase encrypted with the passcode key, so a typed code can be
  -- tested even in an empty room. Useless without the code. Set once, never changed.
  key_check text,
  created_at timestamptz not null default now()
);

create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  session_code text not null references sessions(code) on delete cascade,
  -- plaintext in a standard session, '{"ciphertext": "...", "nonce": "..."}' in the other two
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

-- One row per (room, device). The primary key does the counting, so refreshes, reconnects and
-- two tabs racing can never double count. Backend only.
create table if not exists session_viewers (
  session_code text not null references sessions(code) on delete cascade,
  device_id    text not null,
  first_seen   timestamptz not null default now(),
  primary key (session_code, device_id)
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
create index if not exists session_viewers_session_code_idx on session_viewers (session_code);

-- Row level security
alter table sessions enable row level security;
alter table submissions enable row level security;
alter table clusters enable row level security;
alter table user_sessions enable row level security;
alter table user_submissions enable row level security;
alter table session_viewers enable row level security;

-- Take everything away from the browser roles, then add back only what's needed
revoke all on sessions, submissions, clusters, user_sessions, user_submissions, session_viewers from anon, authenticated;

grant all on sessions, submissions, clusters, user_sessions, user_submissions, session_viewers to service_role;

-- sessions: anyone can read just these columns (never host_notes, curators or key_check).
-- privacy_mode is readable because the sidebar history shows a badge for it.
grant select (code, phase, tags, title, created_at, privacy_mode) on sessions to anon, authenticated;
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

-- Counters updated in one statement, so two people acting at once cannot lose an update.
-- The backend falls back to read-add-write when these do not exist.
create or replace function append_participant_answer(p_id uuid, p_answer text)
returns void
language sql
as $$
  update clusters
     set participant_answers = coalesce(participant_answers, '[]'::jsonb) || to_jsonb(p_answer)
   where id = p_id;
$$;

create or replace function increment_expansion_round(p_code text)
returns void
language sql
as $$
  update sessions set expansion_round = expansion_round + 1 where code = p_code;
$$;

revoke execute on function append_participant_answer(uuid, text) from public, anon, authenticated;
revoke execute on function increment_expansion_round(text) from public, anon, authenticated;
grant execute on function append_participant_answer(uuid, text) to service_role;
grant execute on function increment_expansion_round(text) to service_role;
