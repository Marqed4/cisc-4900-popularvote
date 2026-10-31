-- One row per (room, device). The primary key does the deduplication, so refreshes,
-- reconnects and two tabs racing can never double count.
create table if not exists session_viewers (
  session_code text not null,
  device_id    text not null,
  first_seen   timestamptz not null default now(),
  primary key (session_code, device_id)
);

create index if not exists session_viewers_session_code_idx
  on session_viewers (session_code);
