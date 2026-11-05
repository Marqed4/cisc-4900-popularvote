const KEY = "pv_device_id";

export function getDeviceId() {
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// per-session pseudonym for rooms created with "Hashed identity".
// HMAC-SHA-256 with the device id as the key and the session code as the message, so the same
// device gets the same value inside one session (the unique-device count still works) and an
// unrelated value in every other session. one way: the device id can't be worked out from it.
// the code is public, so it only separates sessions. the device id is the secret part.
const TAG = "popularvote-user-hash-v1:";

export async function sessionUserHash(code) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(getDeviceId()), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(TAG + code)));
  return Array.from(sig, b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
