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
//   - room key kept in localStorage per session so refresh/restart no lose it (E2E-6).
//     anyone with this browser profile (or an XSS) can read it - device = trust boundary
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

// room key persist, one entry per session code. raw key as base64.
// storage can be blocked (private mode etc) - then just fall back to memory only.
function roomKeyStorageKey(code) { return `pv-room-key-${code}`; }

export async function saveRoomKey(code, roomKey) {
  if (!code || code === "NEW") return;
  try {
    localStorage.setItem(roomKeyStorageKey(code), toBase64(await subtle.exportKey("raw", roomKey)));
  } catch (err) {
    console.error("[e2e] room key save failed:", err);
  }
}

export async function loadRoomKey(code) {
  if (!code || code === "NEW") return null;
  try {
    const b64 = localStorage.getItem(roomKeyStorageKey(code));
    if (!b64) return null;
    return await subtle.importKey("raw", fromBase64(b64), { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}

// ---- hashed identity tier: the room key comes from a 6 character passcode ----
// no random room key, no localStorage. host is shown a passcode once at creation, and the key
// is derived from it (PBKDF2-SHA-256, salted with the session code) every time the room is
// opened. forget the passcode, lose the room. nobody can reset it, the server never had it.
//
// honest limit: 6 chars of a 32 letter alphabet is 30 bits. PBKDF2 makes each guess slow but
// someone holding a copy of the database could still grind through every code offline.
// that is the price of a code a human will actually type. E2E tier uses a random 256 bit key.

// Crockford base32: no I, L, O, U, so nobody has to ask "is that a zero".
const PASSCODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PASSCODE_LENGTH = 6;
const PASSCODE_ITERATIONS = 600_000; // OWASP 2023 floor for PBKDF2-HMAC-SHA256

export function generatePasscode() {
  // 256 is a multiple of 32, so masking the low 5 bits is uniform. no modulo bias.
  const bytes = crypto.getRandomValues(new Uint8Array(PASSCODE_LENGTH));
  return Array.from(bytes, b => PASSCODE_ALPHABET[b & 31]).join("");
}

// forgiving input: case, spaces and dashes are ignored, and the lookalikes fold the way
// Crockford says they should (O -> 0, I and L -> 1). returns null if it can't be a passcode.
export function normalizePasscode(input) {
  const clean = String(input ?? "").toUpperCase().replace(/[\s-]/g, "")
    .replace(/O/g, "0").replace(/[IL]/g, "1");
  if (clean.length !== PASSCODE_LENGTH) return null;
  return [...clean].every(ch => PASSCODE_ALPHABET.includes(ch)) ? clean : null;
}

// passcode + session code -> the AES-GCM room key. same inputs, same key, on any device.
// extractable because wrapRoomKey has to export it to hand to joiners.
export async function deriveRoomKeyFromPasscode(passcode, sessionCode) {
  const base = await subtle.importKey("raw", encoder.encode(passcode), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "PBKDF2", hash: "SHA-256", iterations: PASSCODE_ITERATIONS,
      salt: encoder.encode(`popularvote-passcode-v1:${sessionCode}`),
    },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

// a typed passcode can be wrong, and a wrong one still derives a perfectly valid key. so the
// host encrypts a fixed phrase with the real key and the server keeps the result (key_check).
// anyone typing a passcode decrypts that phrase: it comes back right, or AES-GCM throws.
// tells a typo from the real thing even in a room with no questions in it yet.
const KEY_CHECK_PHRASE = "popularvote-key-check-v1";

export async function makeKeyCheck(roomKey) {
  const { ciphertext, nonce } = await encryptText(roomKey, KEY_CHECK_PHRASE);
  return JSON.stringify({ ciphertext, nonce });
}

export async function verifyKeyCheck(roomKey, keyCheck) {
  try {
    const { ciphertext, nonce } = JSON.parse(keyCheck);
    return (await decryptText(roomKey, ciphertext, nonce)) === KEY_CHECK_PHRASE;
  } catch {
    return false;
  }
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