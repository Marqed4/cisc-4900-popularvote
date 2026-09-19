# PopularVote: E2E Encryption + Client-Side Clustering, Build Plan

Threat model: protect question/message content from DB leaks, breaches, and server-side spying. Server (Flask/Railway) and Supabase should only ever see ciphertext.

---

## Devlog entry format (for reference)

```javascript
{
  date: "2026-09-17",
  duration: 1,
  category: "Coding",
  description: "Short summary of what was worked on",
  challenges: "Specific technical obstacles hit and how they were approached",
  reflection: "What you learned or would do differently",
},
```

---

## Phase 1: Key exchange (build first, nothing else works without it)

**Where:** new client-side module, e.g. `frontend/src/lib/crypto.js`

- On session join, each client generates an ephemeral X25519 keypair (via `libsodium-wrappers`, `crypto_box_keypair()`).
- Public key gets sent to the server as an ordinary field on the existing "join session" event; the server (`managers/websocket_manager.py`) just relays it to other participants, same as any other session metadata. It never sees private keys.
- First participant (or session host) generates a random **room key** (symmetric, `crypto_secretbox` key) and distributes it to each joining participant by encrypting it to their public key (`crypto_box_seal` or similar) and sending it once through the socket. The server relays this ciphertext blob without being able to read it.
- Every client now holds the same room key in memory only, never persisted, never sent to Supabase.

**Backend touch points:** `managers/websocket_manager.py` needs new event types (`pubkey_exchange`, `room_key_distribute`) that purely relay opaque blobs, no schema changes needed since it's not interpreting the payload.

---

## Phase 2 - Message encryption

**Where:** wherever questions/messages are currently sent, likely `routes/chat.py` server-side and the corresponding submit handler client-side.

- Client encrypts question text with the room key (`crypto_secretbox`) before emitting the socket event or hitting the `/api/chat` or `/api/submissions` endpoint.
- Flask routes (`routes/chat.py`, `routes/submissions.py`) store the ciphertext blob (+ nonce) in Supabase exactly as they'd store plaintext today, same schema, just opaque bytes in the content column.
- Recipients decrypt client-side with the shared room key on receipt.
- **Decide scope now:** is this opt-in per session ("encrypted mode" toggle when creating a session in `routes/sessions.py`) or global? Opt-in is the realistic path since it lets normal sessions keep full Gemini clustering while encrypted ones use Phase 3.

---

## Phase 3: Client-side clustering (replaces Gemini for encrypted sessions)

**Where:** new client module, e.g. `frontend/src/lib/clustering.js`, running only in the session host/moderator's browser.

1. Add `@huggingface/transformers` (formerly `@xenova/transformers`) to the frontend.
2. Load a quantized small embedding model once per session:
   ```javascript
   import { pipeline } from '@huggingface/transformers';
   const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { device: 'webgpu' });
   ```
   Let the library fall back to `wasm` automatically if WebGPU isn't available, don't hard-code `webgl`, transformers.js doesn't expose it even though the underlying ONNX runtime supports it.
3. As the moderator's client decrypts each incoming question, embed it locally and run cosine-similarity grouping (or a simple k-means pass) over the vectors already in memory, no plaintext or embeddings ever leave the browser.
4. Broadcast only the resulting `{questionId: clusterId}` mapping back through the existing socket channel. This is non-sensitive structural metadata, `managers/websocket_manager.py` relays it exactly like it relays anything else today.
5. Skip Gemini-generated cluster labels; use the most-representative question in each cluster as the header, or a simple most-frequent-terms label computed client-side.
6. Recluster job: since this only runs while a moderator's tab is open, queue newly-arrived encrypted questions and run a catch-up pass on moderator reconnect rather than relying on a server-side periodic job.

---

## Phase 4: Model file hosting

- Default: let `transformers.js` pull from the Hugging Face CDN (simplest, works out of the box).
- If self-hosting for the open-source deploy: serve the quantized model files as static assets from the Render-hosted frontend (`popularvote-frontend.onrender.com`). Render serves static files fine, the browser caches them via the Cache API/IndexedDB after first load, so it's a one-time cost per visitor.
- No changes needed on the Railway-hosted Flask backend for this, it never touches model weights or inference.

---

## Phase 5: Wiring into session settings

- Add an `encrypted` boolean/flag when a session is created (`routes/sessions.py` + Supabase schema) so the frontend knows whether to run the crypto/clustering path or the normal Gemini path for that session.
- Surface it in the UI as a toggle at session creation, with a short explanation of the clustering-quality tradeoff so hosts make an informed choice.

---

## Open decisions before starting

- [ ] Opt-in per-session vs. global encryption
- [ ] TF-IDF (lighter) vs. local embedding model (better clustering, bigger download) for Phase 3
- [ ] Whether to self-host model files on Render or rely on the HF CDN
