# E2E-4: Client-Side Clustering for Encrypted Sessions - Implementation Report

**Date:** 2026-10-19
**Scope:** Closes the client-side clustering gap tracked as E2E-4 in `crypto.js` and `Host.jsx`, plus two plaintext-leak bugs found in the same code path during this work.

---

## 1. Background

Before this change, encrypted sessions could collect submissions but could never reach the RESULTS phase:

- `Host.jsx` hard-blocked the "cluster" button for encrypted sessions with the message *"Clustering for encrypted sessions is not available yet (client-side clustering, E2E-4)"*.
- `routes/sessions.py`'s `cluster_session()` already expected a `clusters` field in the request body for encrypted sessions ("Encrypted session requires client-computed clusters"), but nothing on the client ever produced that payload.
- The server-side clustering path (`managers/clustering_controller.py`) calls the Gemini API on plaintext question text, which doesn't work for encrypted sessions by design - the server never has plaintext to hand it.

This matches `E2E CLUSTERING PLAN.md`'s Phase 3 (client-side clustering replaces Gemini for encrypted sessions), adapted to the clustering data shape the backend had already committed to (`representativeQuery` / `submissionCount` / `questions[].text`) rather than the plan's original id-mapping-only sketch.

## 2. What was built

### 2.1 `src/frontend/src/lib/clustering.js` (new)

A pure, dependency-free clustering function that runs entirely in the browser:

- TF-IDF vectors over tokenized, stop-word-filtered question text.
- Cosine similarity, single-pass greedy assignment (each question joins the first cluster it's similar enough to, or starts a new one, up to a cluster cap).
- Representative query per cluster picked by total word-overlap score against the rest of the cluster (a cheap stand-in for "closest to centroid").
- Output shape matches `clustering_controller.cluster()`'s return value exactly, so the backend doesn't need an encrypted-specific storage path.

**Trade-off made and why:** `E2E CLUSTERING PLAN.md` originally proposed a local embedding model (`@huggingface/transformers`, `Xenova/all-MiniLM-L6-v2`) for better semantic grouping. This implementation uses TF-IDF instead - no model download, no WebGPU/WASM fallback complexity, deterministic and testable, at the cost of weaker semantic matching (it won't group paraphrases that share no vocabulary). If clustering quality turns out to matter more than bundle size, swapping the vectorization step for an embedding pipeline is a contained change - `clusterQuestions()` is the only thing that would need to change.

### 2.2 Keeping the server blind to plaintext

Clustering a session's questions requires the host to have already decrypted them (which `Host.jsx` already did for display, via `readSubmission`). The new flow:

1. Host decrypts submissions (already happened) -> `clusterQuestions()` groups them in plaintext, in memory.
2. Each cluster's `representativeQuery` and every `questions[].text` is re-encrypted with the room key before the POST to `/api/sessions/<code>/cluster` - same `{ciphertext, nonce}` JSON-blob convention submissions already use.
3. The server stores exactly what `managers/clustering_controller.cluster()` would have stored for a non-encrypted session - it just can't read any of it.
4. Everywhere clusters are read back (REST fetch, `session:results`, `cluster:submission:added` sockets), both `Host.jsx` and `Participant.jsx` now decrypt `representative_query` / `questions[].text` the same way they already decrypt submissions, falling back to `"[encrypted: key unavailable]"` if the room key isn't available yet.

### 2.3 Bugs fixed along the way

Two plaintext leaks surfaced while wiring this up, both on the "submit a follow-up into an existing cluster" path (`/clusters/<id>/submit`):

- **`routes/sessions.py: submit_to_cluster()`** had no `nonce` handling at all and applied the flat 500-char limit used for plaintext to every session. It now mirrors `routes/submissions.py: submit()` - requires a nonce for encrypted sessions, applies the 2000-char encrypted limit, and stores/broadcasts the ciphertext blob instead of raw content.
- **`Participant.jsx: submitToCluster()`** sent `content` in the clear even for encrypted sessions (the main `submitQuestion()` already encrypted; this sibling function didn't), and it also wrote the plaintext to the `user_submissions` Supabase table regardless of the `encrypted` flag. Both now match `submitQuestion()`'s behavior.
- **`Host.jsx: submitManualQuestion()`** (host adding a manual question to a cluster) had the same unencrypted-POST gap; fixed the same way, though this function isn't currently wired to any UI control.

### 2.4 Unrelated hardening fix

- **`database/session_store.py: create_session()`** used to swallow any failure writing the `encrypted` column and only print a warning. A session could silently end up stored as unencrypted in Supabase while every client still believed it was E2E-encrypted, and nothing would surface that. The write is no longer wrapped in its own try/except, so a failure now propagates to `SessionManager.create_session()`'s existing handler, where it's already logged in one place instead of two silently diverging ones.

## 3. Files changed

| File | Change |
|---|---|
| `src/frontend/src/lib/clustering.js` | New - TF-IDF/cosine client-side clustering |
| `src/frontend/src/components/Host.jsx` | Encrypted clustering flow, cluster encrypt/decrypt helpers, fixed `submitManualQuestion` |
| `src/frontend/src/components/Participant.jsx` | Cluster decrypt on fetch/socket paths, fixed `submitToCluster` encryption + Supabase leak |
| `src/backend/routes/sessions.py` | `submit_to_cluster()` now nonce/encryption-aware, reuses `ENCRYPTED_CONTENT_LIMIT` |
| `src/backend/database/session_store.py` | `create_session()` no longer swallows the `encrypted`-column write error |
| `src/backend/tests/*` | New pytest suite (see below) |
| `pytest.ini`, `src/backend/requirements-dev.txt` | New - test runner config and dev-only dependency |

## 4. What's still open

- Representative-query/question-text re-encryption happens per-field on every cluster save; for a session with many clusters this is more `crypto.subtle` calls than the non-encrypted path, but no profiling was done to confirm it matters at realistic session sizes.
- Host-authored cluster answers (`cluster:answered`) remain plaintext in both encrypted and non-encrypted sessions - out of scope here, consistent with the original threat model only covering participant-submitted question content.
- The embedding-model upgrade path from `E2E CLUSTERING PLAN.md` (Phase 3/4) was not built; see the trade-off note in 2.1.
- `session_store.create_session()` no longer swallows the error, but `SessionManager.create_session()` still doesn't reconcile the in-memory session's `encrypted: True` against a failed DB write - the failure is now visible in logs, not yet self-healing.

## 5. Test coverage

A new pytest suite lives at `src/backend/tests/`, one file per source module, grouped into one test class per function:

| Test file | Covers |
|---|---|
| `test_session_store.py` | `create_session` (incl. the swallow-fix regression test), `add_submission`, `save_clusters` |
| `test_session_manager.py` | `create_session`, `add_submission`, `save_clusters`, `upvote_question` |
| `test_submissions_route.py` | `submit`, `delete_submission`, `answer_submission` (incl. encrypted vs. plaintext length limits and nonce requirement) |
| `test_sessions_cluster_route.py` | `cluster_session` (incl. the E2E-4 encrypted-clusters-accepted case), `submit_to_cluster` (incl. the plaintext-leak regression tests) |
| `test_clustering_controller.py` | `_clean_json` (the one pure/deterministic helper in that module) |

No test hits a real Supabase project or the Gemini API - `conftest.py` sets dummy credentials so the client-construction calls in `supabase_client.py` and `clustering_controller.py` don't fail at import time, and each test mocks the specific `SessionStore`/`supabase` call it exercises.

Run with (from the repo root, with `src/backend/requirements-dev.txt` installed):

```
pytest
```

Current result: **46 passed, 0 failed.**

## 6. Devlog entry

```javascript
{
  date: "2026-10-19",
  duration: 1,
  category: "Coding",
  description: "Built client-side TF-IDF clustering for encrypted sessions (E2E-4), closing the gap where encrypted sessions could collect submissions but never reach RESULTS. Found and fixed two plaintext-leak bugs in the cluster-submit path along the way, and a silent error-swallow in session creation. Added a pytest suite covering the touched backend code.",
  challenges: "The backend's /cluster route already committed to a specific cluster shape (representativeQuery/questions[].text) before any client-side clustering existed, so the E2E CLUSTERING PLAN.md's original id-mapping sketch didn't fit without a bigger redesign - adapted to re-encrypt the existing fields instead of restructuring storage. Also had to decide TF-IDF vs. a local embedding model under time constraints; went with TF-IDF for determinism and testability.",
  reflection: "Would plan the storage contract and the clustering approach together next time - writing the backend route's expected payload shape before the client-side algorithm existed meant working backward from it instead of designing both together.",
}
```

## Attribute

Organized with the assistance of Qwen 3.8 Max.
