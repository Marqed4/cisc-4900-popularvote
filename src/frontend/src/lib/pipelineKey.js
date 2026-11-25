// pipelineKey.js: derives the HMAC mixing key the custom hash pipeline uses.
// Separate HKDF branch from the AES room key path in crypto.js. Does not import or
// call anything from crypto.js, and crypto.js is not touched by this file.
//
// Same passcode as deriveRoomKeyFromPasscode, but a different HKDF info string, so the
// two keys are cryptographically independent even though they start from the same secret.
// Leaking one key (say, a weak pipeline implementation) does not help an attacker read
// the encrypted room, and vice versa.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

// HKDF info string, this job only (same idea as WRAP_INFO in crypto.js, different value
// so the derived key is a different key).
const PIPELINE_KEY_INFO = encoder.encode("popularvote-pipeline-mix-key-v1");

/**
 * Derives the HMAC-SHA-256 CryptoKey that runPipeline uses to finish the hash pipeline.
 * passcode and sessionCode are the same values deriveRoomKeyFromPasscode in crypto.js
 * takes, but this function is independent: it does its own PBKDF2 and HKDF, and never
 * calls into crypto.js.
 *
 * Two steps, so the HKDF info string is the one thing standing between this key and the
 * room key: PBKDF2(passcode, session salt) gives a secret, then HKDF(secret, this file's
 * own info string) gives the HMAC key. A different info string here would give a totally
 * different key from the same passcode, which is the domain separation this needs.
 * @param {string} passcode the host's shared passcode
 * @param {string} sessionCode the session code, used as a salt like the room key path
 * @returns {Promise<CryptoKey>} an HMAC-SHA-256 key, sign only
 */
export async function derivePipelineMixKey(passcode, sessionCode) {
  const pbkdf2Key = await subtle.importKey("raw", encoder.encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const secretBits = await subtle.deriveBits(
    {
      name: "PBKDF2", hash: "SHA-256", iterations: 600_000,
      salt: encoder.encode(`popularvote-pipeline-passcode-v1:${sessionCode}`),
    },
    pbkdf2Key,
    256,
  );
  const hkdfKey = await subtle.importKey("raw", secretBits, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: PIPELINE_KEY_INFO },
    hkdfKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
