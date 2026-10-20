// E2E crypto, browser only. WebCrypto do work, nothing hand-rolled here.
// server/DB see ciphertext only - session folk only ones read submissions.
//
// built on: W3C WebCrypto API, MDN SubtleCrypto examples, ECDH (NIST SP 800-56A Rev. 3),
// HKDF (RFC 5869), AES-GCM (NIST SP 800-38D). basically DIY HPKE (RFC 9180).
//
// https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
//
// flow:
//   1. host make one random AES-256-GCM room key. same key, every submission, whole session.
//   2. everyone make ECDH P-256 keypair. joiner send pubkey over `pubkey_exchange`.
//      private key never leave browser.
//   3. host wrap room key per-joiner: ECDH(hostPriv, joinerPub) -> HKDF -> AES key,
//      use wrap key to encrypt room key (`room_key_distribute`, field `encryptedRoomKey`).
//      joiner derive same wrap key their side, unwrap it.
//   4. encryptText() give { ciphertext, nonce }, sent as `content`/`nonce` to
//      POST /sessions/<code>/submit. server just store blob, never see plaintext.
//
// known gaps (kanban track, not fix here):
//   - pubkey not authenticated - bad server could MITM key exchange (E2E-7)
//   - room key live in memory only - refresh page, lose it (E2E-6)
//   - one room key whole session, no forward secrecy
//   - no padding - ciphertext length leak roughly how long question was
//   - server still see metadata: who connect, when, how many submission

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// HKDF info string - pin derived key to this one job only (RFC 5869 section 3.2)
const WRAP_INFO = encoder.encode("popularvote-room-key-wrap-v1");
// NIST say 96 bits for GCM nonce. fresh random one every time -
// reuse nonce same key, GCM security guarantee go poof.
const IV_BYTES = 12;

export function toBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i += 0x8000) {
    binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// same trick MDN use, ArrayBuffer to base64 - chunk it so no choke
// on big buffer (String.fromCharCode(...bigArray) blow call stack otherwise)

export function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// step 2: this client ECDH keypair. private key non-extractable, on purpose.
export function generateKeyPair() {
  return subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

// pubkey as base64, go in `publicKey` field for `pubkey_exchange`
export async function exportPublicKey(publicKey) {
  return toBase64(await subtle.exportKey("raw", publicKey));
}

export function importPublicKey(b64) {
  return subtle.importKey("raw", fromBase64(b64), { name: "ECDH", namedCurve: "P-256" }, true, []);
}

// step 1, host only: one random AES-256-GCM key, whole session
export function generateRoomKey() {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// ECDH -> HKDF -> AES-GCM key. only job this key got: wrap room key, nothing else.
async function deriveWrapKey(privateKey, peerPublicKey) {
  const secret = await subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, privateKey, 256);
  const hkdfKey = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: WRAP_INFO },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// step 3, host side: wrap room key for one joiner.
// return base64(nonce || ciphertext) for `encryptedRoomKey` field.
export async function wrapRoomKey(roomKey, ownPrivateKey, peerPublicKey) {
  const wrapKey = await deriveWrapKey(ownPrivateKey, peerPublicKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const raw = await subtle.exportKey("raw", roomKey);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, raw));
  const out = new Uint8Array(IV_BYTES + wrapped.length);
  out.set(iv);
  out.set(wrapped, IV_BYTES);
  return toBase64(out);
}

// step 3, joiner side: unwrap room key with host pubkey. throws if data
// got tampered, or keys don't match - AES-GCM give integrity check for free.
export async function unwrapRoomKey(encryptedRoomKey, ownPrivateKey, peerPublicKey) {
  const wrapKey = await deriveWrapKey(ownPrivateKey, peerPublicKey);
  const data = fromBase64(encryptedRoomKey);
  const raw = await subtle.decrypt(
    { name: "AES-GCM", iv: data.subarray(0, IV_BYTES) },
    wrapKey,
    data.subarray(IV_BYTES),
  );
  return subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// step 4: encrypt a question, return base64 { ciphertext, nonce }. ciphertext go in `content`.
export async function encryptText(roomKey, text) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, roomKey, encoder.encode(text));
  return { ciphertext: toBase64(ct), nonce: toBase64(iv) };
}

// reverse of encryptText. throws if ciphertext messed with, or key wrong.
export async function decryptText(roomKey, ciphertext, nonce) {
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(nonce) },
    roomKey,
    fromBase64(ciphertext),
  );
  return decoder.decode(pt);
}