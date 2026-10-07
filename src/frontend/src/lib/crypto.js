/*
 * crypto.js: client-side encryption for end-to-end encrypted sessions.
 *
 * REFERENCES (what this is based on)
 *   - W3C Web Cryptography API:                   https://www.w3.org/TR/WebCryptoAPI/
 *   - MDN SubtleCrypto (usage and examples):      https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
 *   - ECDH key agreement, NIST SP 800-56A Rev. 3: https://csrc.nist.gov/pubs/sp/800/56/a/r3/final
 *   - HKDF key derivation, RFC 5869:              https://www.rfc-editor.org/rfc/rfc5869
 *   - AES-GCM, NIST SP 800-38D:                   https://csrc.nist.gov/pubs/sp/800/38/d/final
 *   - Same "derive a key, then encrypt to a recipient" idea, standardized as HPKE (RFC 9180):
 *                                                 https://www.rfc-editor.org/rfc/rfc9180
 *
 * Everything runs on the browser's built-in WebCrypto API, so there are no extra
 * dependencies and nothing hand-rolled. The goal is simple: the server and database only
 * ever see ciphertext, and only people in the session can read what gets submitted.
 *
 * HOW IT WORKS
 *   1. Room key. The host makes one random AES-256-GCM key for the whole session, and
 *      every submission gets encrypted with it.
 *   2. Key exchange. Everyone makes an ECDH P-256 keypair. Joiners send their public key
 *      to the room (socket event `pubkey_exchange`). Private keys never leave the browser.
 *   3. Handing out the room key. For each joiner, the host does ECDH with its private key
 *      and their public key, runs the shared secret through HKDF, and uses the result to
 *      encrypt ("wrap") the room key. Only that joiner receives it (`room_key_distribute`,
 *      field `encryptedRoomKey`), and they do the same math from their side to unwrap it.
 *   4. Submitting. `encryptText` returns { ciphertext, nonce }. The client sends those as
 *      `content` and `nonce` to POST /sessions/<code>/submit. The server stores them as-is
 *      and never decrypts anything.
 *
 * WHAT THIS DOESN'T COVER (yet, all tracked on the kanban board)
 *   - Public keys aren't authenticated. A malicious server could swap one and read the
 *     room key (man-in-the-middle). The fix is comparing key fingerprints (E2E-7).
 *   - Keys only live in memory, so a page refresh loses the room key (E2E-6).
 *   - One room key per session and no forward secrecy. Whoever gets it can read the
 *     whole session.
 *   - No padding, so ciphertext length gives away roughly how long a question was.
 *   - The server still sees metadata: who's connected, when submissions happen, how many.
 */

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// HKDF "info" string. It pins the derived key to this one job (see RFC 5869 section 3.2).
const WRAP_INFO = encoder.encode("popularvote-room-key-wrap-v1");
// 96-bit nonce is the size NIST recommends for AES-GCM (SP 800-38D, section 5.2.1.1).
// Every encryption gets a fresh random one. Reusing a nonce with the same key breaks GCM.
const IV_BYTES = 12;

export function toBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < arr.length; i += 0x8000) {
    binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/*
const base64 = btoa(
String.fromCharCode(...new Uint8Array(buffer))
);
*/

export function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Step 2: make this client's ECDH keypair. The private key can't be exported. */
export function generateKeyPair() {
  return subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

/** Public key as base64 (raw point), used for the `publicKey` field in `pubkey_exchange`. */
export async function exportPublicKey(publicKey) {
  return toBase64(await subtle.exportKey("raw", publicKey));
}

export function importPublicKey(b64) {
  return subtle.importKey("raw", fromBase64(b64), { name: "ECDH", namedCurve: "P-256" }, true, []);
}

/** Step 1 (host only): random AES-256-GCM key for the whole session. */
export function generateRoomKey() {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// ECDH shared secret, then HKDF, then an AES-GCM key that's only used to wrap the room key.
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
 * Step 3, host side: wrap the room key for one joiner.
 * Returns base64(nonce || ciphertext), which goes in `encryptedRoomKey`.
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
 * Step 3, joiner side: unwrap the room key using the host's public key. Throws if the
 * data was tampered with or the keys don't match (AES-GCM checks integrity for free).
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

/** Step 4: encrypt a question. Returns base64 { ciphertext, nonce }. Send ciphertext as `content`. */
export async function encryptText(roomKey, text) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, roomKey, encoder.encode(text));
  return { ciphertext: toBase64(ct), nonce: toBase64(iv) };
}

/** Reverse of encryptText. Throws if the ciphertext was messed with or the key is wrong. */
export async function decryptText(roomKey, ciphertext, nonce) {
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(nonce) },
    roomKey,
    fromBase64(ciphertext),
  );
  return decoder.decode(pt);
}