-- One privacy_mode column in place of encrypted + hashed_identity, plus key_check,
-- session_viewers and two counter functions the code uses but the old schema never created.
--
-- Run in the Supabase SQL editor in two steps:
--   Step 1  before deploying the new code. Only adds things, so the old code keeps working.
--   Step 2  after the new code is live. Drops the old flag columns. Cannot be undone.
--
-- Safe to run twice: every statement checks first.


-- Step 1: additive

-- The three privacy modes, as one column instead of two booleans.
--   standard   server can read questions (AI grouping and suggested answers)
--   encrypted  end to end, key handed out by the host's browser
--   passcode   end to end, key comes from a code the host shares
alter table sessions add column if not exists privacy_mode text not null default 'standard';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_privacy_mode_check') then
    alter table sessions
      add constraint sessions_privacy_mode_check
      check (privacy_mode in ('standard', 'encrypted', 'passcode'));
  end if;
end $$;

-- Carry existing rooms over. These two columns existed in the live database even though the
-- schema file never created them, so check before reading them.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_name = 'sessions' and column_name = 'hashed_identity') then
    update sessions set privacy_mode = 'passcode'
      where hashed_identity is true and privacy_mode = 'standard';
  end if;
  if exists (select 1 from information_schema.columns
             where table_name = 'sessions' and column_name = 'encrypted') then
    update sessions set privacy_mode = 'encrypted'
      where encrypted is true and privacy_mode = 'standard';
  end if;
end $$;

-- The browser reads it for the badge in the session history, same as the old flags.
grant select (privacy_mode) on sessions to anon, authenticated;

-- The passcode check phrase. Encrypted with the passcode key, so the server cannot read it.
alter table sessions add column if not exists key_check text;

-- One row per (room, device). The primary key does the counting, so refreshes, reconnects
-- and two tabs racing can never double count. Backend only.
create table if not exists session_viewers (
  session_code text not null references sessions(code) on delete cascade,
  device_id    text not null,
  first_seen   timestamptz not null default now(),
  primary key (session_code, device_id)
);
create index if not exists session_viewers_session_code_idx on session_viewers (session_code);
alter table session_viewers enable row level security;
revoke all on session_viewers from anon, authenticated;
grant all on session_viewers to service_role;

-- Two counters the backend updates in one statement, so two people acting at once cannot lose
-- an update. The backend uses them when they exist and falls back to read-then-write when not.
--
-- Some databases already have these from an earlier setup, so each is only created when no
-- function of that name exists. Never add a second version with a different argument type:
-- the API then cannot tell them apart and refuses to call either (error PGRST203).
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'append_participant_answer') then
    create function public.append_participant_answer(p_id uuid, p_answer text)
    returns void
    language sql
    as $fn$
      update clusters
         set participant_answers = coalesce(participant_answers, '[]'::jsonb) || to_jsonb(p_answer)
       where id = p_id;
    $fn$;
  end if;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'increment_expansion_round') then
    create function public.increment_expansion_round(p_code text)
    returns void
    language sql
    as $fn$
      update sessions set expansion_round = expansion_round + 1 where code = p_code;
    $fn$;
  end if;
end $$;

-- An earlier draft of this file created append_participant_answer(uuid, jsonb) next to the
-- existing (uuid, text) one. If that ran, this removes the extra copy and leaves yours.
drop function if exists public.append_participant_answer(uuid, jsonb);

revoke execute on function public.append_participant_answer(uuid, text) from public, anon, authenticated;
revoke execute on function public.increment_expansion_round(text) from public, anon, authenticated;
grant execute on function public.append_participant_answer(uuid, text) to service_role;
grant execute on function public.increment_expansion_round(text) to service_role;


-- Step 2: cleanup. Run only after the new code is deployed, and only these lines.

-- Re-run the carry-over first, in case the old server created a room between step 1 and the
-- deploy. After this the old flags hold nothing the new column does not.
-- update sessions set privacy_mode = 'passcode'  where hashed_identity is true and privacy_mode = 'standard';
-- update sessions set privacy_mode = 'encrypted' where encrypted is true and privacy_mode = 'standard';
--
-- Then drop the old flags and the grant that exposed them.
-- revoke select (encrypted, hashed_identity) on sessions from anon, authenticated;
-- alter table sessions drop column if exists encrypted;
-- alter table sessions drop column if exists hashed_identity;
