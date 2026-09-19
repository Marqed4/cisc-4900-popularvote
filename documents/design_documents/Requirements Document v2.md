# Popular Vote Requirements Document

Date Updated: 2026-09-18
Version: 2.0
Team: Alou Kone, Zachery Francis, Jonathan Koral, Andrew Li
Supersedes: `Original Requirements Document.pdf` (v1.0, 2026/03/09). Sections below are marked
**(unchanged)**, **(changed)**, or **(new)** relative to v1.0 so the delta is traceable.

## Context

### CTX1: Description (unchanged)

Popular Vote is a web-based application that allows participants in a shared session to privately
submit questions about a topic. The system collects these questions, uses AI to cluster similar ones,
and condenses them into a clear, organized set of representative queries. Instead of a moderator
fielding dozens of scattered, redundant, or never-verbalized questions, session hosts receive a
structured view of what the group actually wants to understand. The goal is to surface collective
concerns without putting pressure on individuals to speak up.

### CTX2: Scope (changed)

- CTX2.1: Popular Vote is scoped to structured, host-moderated sessions where participants submit
  questions and a host (and, since v2.0, promoted curators) views the clustered results.
- CTX2.2: Out of scope for v1.0, now **implemented** and no longer out of scope:
  - Participant-facing display of individual submissions: participants now see the original
    questions grouped under each cluster, not just the representative query (v1.0 CTX2.2.1).
  - Live-updating clusters: the host can trigger a re-cluster while a session is still open or in
    `RESULTS`, and new submissions since the last pass are incrementally merged into existing
    clusters rather than reclustering from scratch (v1.0 CTX2.2.2).
  - Multi-host / co-moderator sessions: a host can promote participants to **curator**, who share
    the host's ability to answer clusters and manage the session (v1.0 CTX2.2.6).
- CTX2.3: Still explicitly out of scope:
  - User accounts, authentication, or persistent profiles (no login exists anywhere in the system).
  - Automated content moderation of submission text before it reaches the AI or other participants.
  - Analytics or cross-session history (each session's data lives in its own row set; there is no
    dashboard aggregating across sessions).
- CTX2.4 **(new)**: Optional per-session end-to-end encryption is in scope as an opt-in mode. When a
  session is created encrypted, submission content and AI clustering are handled without the server
  or Gemini ever seeing plaintext; see FR6.

### CTX3: User Classes (changed)

- CTX3.1: **Session Host.** Creates and manages a session, shares the session code, and can
  initiate/re-trigger AI clustering. Each session has exactly one Host, identified by socket
  connection, not credentials.
- CTX3.2 **(new)**: **Curator.** A Participant promoted by the Host. Curators can answer clusters,
  see host notes context, and otherwise act with host-level permissions on clustering/answers, but
  cannot delete or end the session. Promotion is tracked per session (`curators` list) and is
  revocable.
- CTX3.3: **Participant.** Joins an active session using a session code and privately submits one or
  more questions. Cannot see other participants' identity, but can see clustered output (including
  grouped original questions) once released, and can upvote individual questions within a cluster.

### CTX4: Operating Environment (unchanged)

- CTX4.1: Runs in a standard web browser on any desktop or mobile device. No installation required.
- CTX4.2: Both Hosts and Participants must have an active internet connection for the session's
  duration.
- CTX4.3: AI clustering is performed by a third-party language model API (Google Gemini) over the
  internet and is unavailable offline. **(changed)** For encrypted sessions, clustering instead runs
  client-side in the moderator's browser using a local embedding model; Gemini is not called for
  encrypted sessions at all.

### CTX5: Assumptions and Dependencies (changed)

- CTX5.1: The Host communicates the session code to participants through an external channel. The
  system does not handle participant outreach, though it does generate a QR code for mobile joins
  (v1.0 FD7, implemented).
- CTX5.2: Participants are assumed to act in good faith; the system does not enforce content
  moderation.
- CTX5.3: The Gemini API is assumed available and responsive during clustering, host-notes-based
  answer suggestion generation, and chat. **(new)** For encrypted sessions, this dependency is
  removed for clustering and chat; both are unavailable rather than degraded, by design.
- CTX5.4 **(new)**: Session, submission, and cluster state is assumed to persist in Supabase across
  server restarts and multiple backend instances; the in-memory `SessionManager` cache is a
  performance layer over Supabase, not the source of truth. This reverses the v1.0 stateless
  assumption; see NFR5.

---

## Functional Requirements

### FR1: Session Creation (Host) (changed)

- FR1.1–FR1.4 (unchanged): create a session without an account, get a short unique join code shown
  prominently, see a live participant count.
- FR1.5 (unchanged): close the submission window at any time.
- FR1.6 **(changed)**: clustering can now be triggered while the session is `OPEN`, `CLOSED`, or
  `RESULTS`, not only after close, to support incremental/live clustering.
- FR1.7 (unchanged): add tags to give the AI session context.
- FR1.8 **(new)**: the Host can set a title and description for the session and edit them later.
- FR1.9 **(new)**: the Host can upload a PDF or paste text as "host notes"; extracted text is used
  as grounding context for AI-suggested cluster answers (see FR4.9) and is never shown to
  participants directly.
- FR1.10 **(new)**: the Host can create a session as **encrypted** (FR6.1). This choice is made at
  creation and is not changeable afterward in the current implementation.

### FR2: Session Joining (Participant) (unchanged)

- FR2.1: join by entering a session code, no account required.
- FR2.2: invalid/expired codes are rejected with a clear error.
- FR2.3: joins to a session whose submission window is closed are rejected with a clear message,
  except that a session in `ENDED` phase instead returns its final participant count and marks a
  summary as available, rather than a hard rejection.

### FR3: Question Submission (Participant) (changed)

- FR3.1–FR3.2 (unchanged): submit one or more text questions after joining.
- FR3.3 (unchanged): a participant's own submissions are not shown to other participants as
  attributed to them; grouped questions become visible to everyone once clustered (this is the
  CTX2.2.1 scope change, not a privacy regression, no identity is ever attached).
- FR3.4 (unchanged): no identifying information (IP, device ID, socket ID) is attached to a stored
  question.
- FR3.5–FR3.6 (unchanged): empty submissions are rejected; a character limit is enforced (500
  plaintext, or 2000 for encrypted sessions to accommodate ciphertext+nonce overhead, FR6.3).
- FR3.7 (unchanged): successful submission is confirmed to the participant.
- FR3.8 (unchanged): a participant can delete their own submission.
- FR3.9 **(new)**: a participant can submit a question directly into an existing cluster (rather
  than the general pool), which the host or curator can review already grouped as intended.
- FR3.10 **(new)**: the system rate-limits submissions per client (10/minute) to prevent spam.

### FR4: AI Clustering (changed)

- FR4.1–FR4.4 (unchanged): triggering clustering sends collected questions to Gemini and returns a
  condensed, labeled set of clusters with approximate contributing counts; a processing indicator is
  shown during the call.
- FR4.5–FR4.6 (unchanged): API failures return the session to a retryable state without losing
  submissions; clustering with zero submissions is rejected without an API call.
- FR4.7 (unchanged): the Host can delete a cluster.
- FR4.8 (unchanged): multi-question submissions are split into separate questions by the AI prompt.
- FR4.9 **(new)**: if host notes are present, the system generates a suggested answer per cluster via
  a RAG-style prompt over the host notes, surfaced to the Host/curators as a starting point, not
  auto-published.
- FR4.10 **(new)**: after a Host answers a cluster, the system can generate follow-up question
  suggestions based on that answer and the cluster's original questions.
- FR4.11 **(new)**: participants can upvote individual questions within a cluster (v1.0 FD6,
  implemented); upvote counts are visible to hosts and participants alike.
- FR4.12 **(new)**: the Host can trigger a session "expansion round," reopening submissions for
  additional questions on the same clustered topics without starting a new session.
- FR4.13 **(new, encrypted sessions only)**: for encrypted sessions, clustering is computed client-
  side by the moderator's browser and submitted to the server as a finished result; the server does
  not call Gemini and does not compute clusters itself for these sessions (see FR6.4).

### FR5: Session Lifecycle (unchanged)

- FR5.1: the Host can end a session after clustering.
- FR5.2: ending a session prevents further participant access to that code.
- FR5.3: submissions after the window closes are rejected with a clear message.
- FR5.4: ending a session displays a condensed summary (representative query, contributing count,
  host answer, upvote totals) to the Host and all active Participants, with a copy-to-clipboard
  export.

### FR6: End-to-End Encrypted Sessions **(new)**

- FR6.1: a session can be created with an `encrypted` flag. This routes the session through a
  separate handling path for the remainder of its lifecycle.
- FR6.2: participants and the host/moderator exchange public keys and a shared room key over the
  existing WebSocket channel; the server relays this key material as opaque blobs and never has
  access to plaintext keys.
- FR6.3: submission content for encrypted sessions is ciphertext plus a nonce; the server stores it
  as received and never attempts to interpret or moderate it.
- FR6.4: clustering for encrypted sessions is computed client-side (local embeddings + similarity
  grouping) by the moderator's browser rather than by calling Gemini; the server accepts a finished
  cluster set from the moderator and stores/broadcasts it exactly as it would a Gemini result.
- FR6.5: the chat feature (FR7) is unavailable for encrypted sessions, since answering it would
  require sending ciphertext to Gemini as if it were plaintext.

### FR7: Session Chat Assistant **(new)**

- FR7.1: while viewing a session, a user can chat with an AI assistant grounded in that session's
  current clusters (representative queries, counts, and a sample of original questions).
- FR7.2: unavailable for sessions with no clusters yet, or for encrypted sessions (FR6.5).

---

## Non-Functional Requirements

- NFR1 (unchanged): **Submission Anonymity.** No PII (IP, device ID, session cookie) is stored,
  logged, or transmitted linked to a submission.
- NFR2 (unchanged): **Session Privacy.** A session is accessible only via its unique code; sessions
  are not discoverable or listable.
- NFR3 (unchanged): **Submission Responsiveness.** Submissions are acknowledged within two seconds
  under normal network conditions.
- NFR4 (unchanged): **Clustering Latency.** The clustering API call is initiated within one second
  of the trigger; total round-trip time depends on the third-party API.
- NFR5 **(changed, was a hard guarantee in v1.0)**: **Data Retention.** Session, submission, and
  cluster rows are now persisted in Supabase and are **not** automatically discarded when a session
  ends; `phase` moves to `ENDED` but rows remain queryable until a host explicitly deletes the
  session (`DELETE`-equivalent path removes the Supabase rows). This is a deliberate reversal of the
  v1.0 "ephemeral, no persistence" guarantee, made to support server restarts and multi-instance
  deployment. **Anonymity (NFR1) still holds** since no PII is stored regardless of retention.
- NFR6 (unchanged): **Concurrent Submissions.** Multiple simultaneous submissions within a session
  are correctly accepted and stored.
- NFR7 (unchanged): rate limiting prevents submission spam (10/minute per client, enforced).
- NFR8 **(new)**: **Confidentiality for encrypted sessions.** For a session created with `encrypted`
  set, submission content must not be recoverable by the server or by Gemini at any point in the
  pipeline. This is a stronger guarantee than NFR1 (which covers identity, not content) and applies
  only to sessions that opt in.

Note on omitted categories (unchanged): maintainability logging remains a low priority given the
lack of accounts; failover infrastructure is out of scope given the session-based nature of the
system, though Supabase persistence (NFR5) now provides some resilience to a single backend
instance restarting.

---

## Data Requirements (changed)

### DR1: Session State (changed)

- DR1.1: a unique session code and its phase (`OPEN`, `CLOSED`, `CLUSTERING`, `RESULTS`,
  `EXPANDING`, `ENDED`, `DELETED`, the last two are new since v1.0's four-phase model).
- DR1.2: live participant count.
- DR1.3: submission window open/closed state, derived from phase.
- DR1.4: whether clustering has been initiated and whether results are available.
- DR1.5 **(new)**: title, description, host notes (extracted PDF/pasted text), tags, curator list,
  expansion round count, and the `encrypted` flag.

### DR2: Question Submissions (unchanged)

- DR2.1: text content of each submission, persisted for the session's lifetime (see NFR5).
- DR2.2: each submission is associated with its session, not with any individual participant.
- DR2.3 **(new)**: for encrypted sessions, "text content" is a ciphertext+nonce pair rather than
  plaintext (see FR6.3).

### DR3: Clustering Output (changed)

- DR3.1: AI-generated (or, for encrypted sessions, client-computed) cluster output, persisted for
  the session's lifetime.
- DR3.2: approximate contributing submission count per cluster.
- DR3.3 **(new)**: per-cluster host answer, upvote counts per question, selected/previewed questions
  (from expansion rounds), and contextual facts gathered during expansion.

---

## Constraints (changed)

- CON1 (unchanged): clustering depends on the Gemini API's availability, latency, and terms.
- CON2 (unchanged): no offline support; both creation and submission require an internet connection.
- CON3 (unchanged): no authentication; a Host is identified only by socket connection, and nothing
  prevents one participant from submitting multiple questions beyond rate limiting.
- CON4 (unchanged): no automated content moderation; submissions go to Gemini as-is (for
  non-encrypted sessions).
- CON5 **(changed, reversed from v1.0)**: session data is **not** automatically discarded when a
  session ends (see NFR5); it persists in Supabase until explicit deletion.
- CON6 **(new)**: encrypted sessions have no key-recovery mechanism. If the moderator's browser tab
  closes before the room key is redistributed to a reconnecting client, that client cannot decrypt
  session content; there is currently no server-side fallback for this by design (the server never
  holds the room key).
- CON7 **(new)**: encrypted sessions currently have no identity verification step for the key
  exchange (e.g., a safety-number comparison). The server relaying public keys is trusted not to
  substitute its own; a fully active malicious server could still perform a man-in-the-middle attack
  against the key exchange. This is an accepted limitation of the current design, not a solved
  problem.

---

## Future Directions (changed)

Implemented since v1.0, removed from this list: FD1 (host-controlled release is partially covered by
cluster deletion and the answer flow), FD2 (live/incremental clustering), FD6 (question upvoting),
FD7 (QR code generation).

- FD8 **(new)**: identity verification for the E2E key exchange (e.g., safety-number/QR comparison
  between host and participant) to close the gap in CON7.
- FD9 **(new)**: room-key durability across moderator reconnects for encrypted sessions, to close the
  gap in CON6, e.g. by re-deriving and redistributing the key on rejoin rather than relying on a
  single browser tab staying open.
- FD10 **(new)**: explicit, host-triggered data deletion/export flow now that data outlives a session
  (NFR5 changed this), so hosts have a clear way to purge a session's Supabase rows if desired.
- FD4 (unchanged from v1.0, still not implemented): formal session history/export UI beyond the
  existing copy-to-clipboard summary.
- FD5 (unchanged from v1.0, still not implemented): persistent Host accounts.
- FD3 (unchanged from v1.0, still not implemented): a content moderation layer before clustering.

---

## Appendix A: Glossary (changed)

- A1-A5 (unchanged): Session, Session Code, Submission Window, Clustering, Cluster, as defined in
  v1.0.
- A6 **(new)**: **Curator.** A participant promoted by the Host with host-level permissions over
  clustering and answers, but not session deletion/ending.
- A7 **(new)**: **Encrypted Session.** A session created with the `encrypted` flag set, in which
  submission content and clustering never pass through the server or Gemini as plaintext.
- A8 **(new)**: **Room Key.** The symmetric key shared among all clients in an encrypted session,
  used to encrypt/decrypt submission content; generated by the first participant/host and
  distributed to each joiner via their public key, held only in browser memory.
- A9 **(new)**: **Expansion Round.** A host-triggered reopening of submissions on an already-
  clustered session's topics, incrementing `expansionRound` without starting a new session.

## Appendix B: Reading References **(new)**

Background reading relevant to finishing the backend and the E2E encryption plan.

### Python / backend stack

- Flask (routing, blueprints, app factory patterns): https://flask.palletsprojects.com/
- Flask-SocketIO (rooms, broadcasting, the event model `websocket_manager.py` builds on):
  https://flask-socketio.readthedocs.io/
- Flask-Limiter (the rate limiting behind FR3.10): https://flask-limiter.readthedocs.io/
- Supabase Python client (`database/supabase_client.py`, `session_store.py`):
  https://supabase.com/docs/reference/python/introduction
- Google Gen AI Python SDK (`google-genai`, used for clustering, chat, and suggested answers):
  https://ai.google.dev/gemini-api/docs/sdks
- pypdf (host-notes PDF text extraction, FR1.9): https://pypdf.readthedocs.io/
- eventlet (the async worker model `gunicorn` uses in production for Flask-SocketIO):
  https://eventlet.readthedocs.io/

### Cryptography / SHA-256 / the E2E plan

- NIST FIPS 180-4, the SHA-2 family specification (defines SHA-256 itself):
  https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf
- Python's `hashlib` (`hashlib.sha256`, stdlib SHA-256 if any server-side hashing is ever needed,
  e.g. verifying a client-supplied checksum without touching plaintext content):
  https://docs.python.org/3/library/hashlib.html
- libsodium documentation (the primitives `crypto_box_keypair`, `crypto_box_seal`, and
  `crypto_secretbox` in the E2E plan are built on): https://doc.libsodium.org/
- libsodium-wrappers (JS bindings the plan's frontend `crypto.js` module would use):
  https://github.com/jedisct1/libsodium.js
- PyNaCl (Python bindings for libsodium, useful if any server-side crypto helper is ever needed,
  e.g. to validate blob shapes without decrypting them): https://pynacl.readthedocs.io/
- RFC 7748, Elliptic Curves for Security (defines X25519, the key-exchange curve the plan's Phase 1
  keypair uses): https://www.rfc-editor.org/rfc/rfc7748
- NaCl's own "Secret-key cryptography" and "Public-key cryptography" pages (plain-language
  explanation of `secretbox` vs `box`, i.e. the room key vs the per-participant key exchange):
  https://nacl.cr.yp.to/secretbox.html and https://nacl.cr.yp.to/box.html
- OWASP Cryptographic Storage Cheat Sheet (general guardrails relevant to CON6/CON7, key handling
  and the lack of identity verification in the current key exchange):
  https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
