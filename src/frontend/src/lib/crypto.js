/*

 * REFERENCES
 *   - W3C Web Cryptography API:            https://www.w3.org/TR/WebCryptoAPI/
 *   - MDN SubtleCrypto (usage and examples): https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
 *   - ECDH key agreement, NIST SP 800-56A Rev. 3: https://csrc.nist.gov/pubs/sp/800/56/a/r3/final
 *   - HKDF key derivation, RFC 5869:         https://www.rfc-editor.org/rfc/rfc5869
 *   - AES-GCM, NIST SP 800-38D:              https://csrc.nist.gov/pubs/sp/800/38/d/final
 *   - Same "derive a key, then encrypt to a recipient" pattern, standardized as HPKE,
 *     RFC 9180:                              https://www.rfc-editor.org/rfc/rfc9180
 * Client-side crypto for end-to-end encrypted sessions.
 * Uses only the browser's built-in WebCrypto API, so there are no dependencies and no
 * hand-written primitives.
 *
 * GOAL
 *   The server and database only ever see ciphertext. Only people in the session can
 *   read submissions.
 *
 * HOW IT WORKS
 *   1. Room key. The host makes one random AES-256-GCM key for the session. Every
 *      submission is encrypted with it.
 *   2. Key exchange. Each client makes an ECDH P-256 keypair and sends its public key
 *      to the room (socket event `pubkey_exchange`). The private key never leaves the
 *      browser and is non-extractable.
 *   3. Key distribution. For each joiner, the host combines its own private key with
 *      the joiner's public key (ECDH) to get a shared secret that only those two can
 *      compute. The secret is run through HKDF to make a one-purpose AES key, which
 *      encrypts ("wraps") the room key. The result goes to that joiner only (socket
 *      event `room_key_distribute`, field `encryptedRoomKey`). The joiner repeats the
 *      ECDH step with the host's public key and unwraps the room key.
 *   4. Submitting. `encryptText` returns { ciphertext, nonce }. The client sends
 *      ciphertext as `content` and the nonce as `nonce` to POST /sessions/<code>/submit.
 *      The server stores them as-is and never decrypts.
 *
 * WHAT IT DOES NOT PROTECT (known limits, tracked on the kanban board)
 *   - Public keys are not authenticated. A malicious server could swap a public key and
 *     read the room key (man-in-the-middle). Fix: compare key fingerprints out of band
 *     (E2E-7).
 *   - Keys live in memory only. A page refresh loses the room key (E2E-6).
 *   - One room key per session, no forward secrecy. Anyone who obtains it can read the
 *     whole session.
 *   - Ciphertext length reveals roughly how long each question is. There is no padding.
 *   - The server still sees metadata: who is online, when submissions happen, how many.
 */

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// HKDF "info" string: ties the derived key to this one purpose (NIST SP 800-56A, RFC 5869 §3.2).
const WRAP_INFO = encoder.encode("popularvote-room-key-wrap-v1");
// 96-bit nonce is the recommended size for AES-GCM (NIST SP 800-38D §5.2.1.1).
// A fresh random nonce is used for every encryption; reusing one with the same key breaks GCM.
const IV_BYTES = 12;

export function toBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i += 0x8000) {
    binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Step 2: make this client's ECDH keypair. The private key is non-extractable. */
export function generateKeyPair() {
  return subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

/** Public key to base64 (raw point), for the `publicKey` field of `pubkey_exchange`. */
export async function exportPublicKey(publicKey) {
  return toBase64(await subtle.exportKey("raw", publicKey));
}

export function importPublicKey(b64) {
  return subtle.importKey("raw", fromBase64(b64), { name: "ECDH", namedCurve: "P-256" }, true, []);
}

/** Step 1: host only. Random AES-256-GCM key for the whole session. */
export function generateRoomKey() {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// ECDH shared secret -> HKDF -> AES-GCM key used only to wrap the room key.
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

/**
 * Step 3, host side: encrypt the room key for one joiner.
 * Returns base64(nonce || ciphertext), the value for `encryptedRoomKey`.
 */
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

/**
 * Step 3, joiner side: recover the room key. Pass the host's public key. Throws if the
 * data was tampered with or the keys do not match (AES-GCM checks integrity).
 */
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

/** Step 4: encrypt a question. Returns base64 { ciphertext, nonce }; send ciphertext as `content`. */
export async function encryptText(roomKey, text) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, roomKey, encoder.encode(text));
  return { ciphertext: toBase64(ct), nonce: toBase64(iv) };
}

/** Reverse of encryptText. Throws if the ciphertext was altered or the key is wrong. */
export async function decryptText(roomKey, ciphertext, nonce) {
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(nonce) },
    roomKey,
    fromBase64(ciphertext),
  );
  return decoder.decode(pt);
}
