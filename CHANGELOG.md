# Changelog

## Unreleased

### Added
- Sidebar history shows a privacy tier badge next to the phase badge. Tiers map to the two
  flags the server stores:

  | tier | encrypted | hashed_identity |
  |---|---|---|
  | Normal | false | false |
  | Encrypted | true | false |
  | Hashed identity | true | true |

  Null or missing flags on old rows read as Normal. Each badge has a `title` tooltip, so color
  is never the only cue. The hashed badge has a lighter violet in the dark theme.
- Hashed identity rooms: passcode-derived room key, per-session user hash, and a one-time
  `POST /api/sessions/<code>/key-check` canary so a mistyped passcode can be told from the
  real one. `GET /api/sessions/<code>` now returns `hashedIdentity` and `keyCheck`.
- `sessions.hashed_identity` column (see `documents/legacy_documents/PostgreSQL Tables.txt`).
- Frontend test runner (vitest + jsdom + Testing Library). Run with `npm run test:frontend`.

### Fixed
- Sidebar history for signed-in users never selected `encrypted` / `hashed_identity`, so every
  saved session showed as Normal.

### Tests
- Backend: `create_session` and `set_key_check` in the store, tier flags and key check in the
  manager (including rows hydrated from the database), and the create, get and key-check routes.
- Frontend: Sidebar badges for each tier on both the signed-in and signed-out paths, dismiss
  and navigate; passcode generation, normalization, key derivation and key check; device id and
  the per-session user hash.

### Assumed, not verified
- The `encrypted` and `hashed_identity` columns exist on the live Supabase `sessions` table. If
  they don't, the sidebar select errors and history comes up empty.

### Open
- Tier label wording. The app says Normal / End-to-end encrypted / Hashed identity, the
  badge says Normal / Encrypted / Hashed identity.
