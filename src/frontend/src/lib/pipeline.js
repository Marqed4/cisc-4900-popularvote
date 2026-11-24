// pipeline.js: the custom hash pipeline (the owner's "user derived hashing").
// Guarded pipeline, not a formula language. Steps are plain data, never code. No eval, ever.
//
// Allowed ops and ranges:
//   substring   { from, to }   0 <= from < to <= 64, text in, text out
//   repeat      { n }          1 <= n <= 8, text in, text out
//   salt        { }            appends a fixed salt, text in, text out
//   fnv         { }            32-bit FNV-1a, text in, number out
//   shiftLeft   { n }          0 <= n <= 31, number in, number out
//   shiftRight  { n }          0 <= n <= 31, number in, number out
//   and         { mask }       0 <= mask <= 0xffffffff, number in, number out
//   xor         { mask }       0 <= mask <= 0xffffffff, number in, number out
//   rotate      { n }          0 <= n <= 31, number in, number out
//
// Type rule: starts as text. fnv is the only text to number step. Numeric ops need a
// number already, so they must come after fnv. Text ops are rejected once fnv has run.
//
// Limits, checked before and after every step, never truncated:
//   at most 8 steps, text at most 64 chars at every point, repeat n at most 8.
//   Final output is always one 32-byte HMAC-SHA-256 tag, well under MAX_OUTPUT_BYTES.
//
// Keys: the mixing key is its own HMAC key, a separate HKDF branch from the AES room key
// (same idea as WRAP_INFO in crypto.js). This file takes that key as a param, derives
// nothing itself, and never touches deriveRoomKeyFromPasscode, wrapRoomKey, or any other
// function in crypto.js.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

export const MAX_STEPS = 8;
export const MAX_TEXT_CHARS = 64;
export const MAX_OUTPUT_BYTES = 256;
export const MAX_REPEAT_N = 8;

// Public salt text, same idea as the rest of the pipeline. Passcode is the only secret.
const SALT_TEXT = "popularvote-pipeline-salt-v1";

// Ops with no params. Extra-field check in validatePipeline already blocks any field
// on these, so by the time this runs there is nothing left to check.
const noParams = () => true;

// Allowlist. `params` names the only fields a step may carry besides "op".
const OPS = {
  substring: {
    needs: "text", gives: "text", params: ["from", "to"],
    validParams: (p) =>
      Number.isInteger(p?.from) && Number.isInteger(p?.to) &&
      p.from >= 0 && p.to <= MAX_TEXT_CHARS && p.from < p.to,
    run: (text, p) => text.slice(p.from, p.to),
  },
  repeat: {
    needs: "text", gives: "text", params: ["n"],
    validParams: (p) => Number.isInteger(p?.n) && p.n >= 1 && p.n <= MAX_REPEAT_N,
    run: (text, p) => text.repeat(p.n),
  },
  salt: {
    needs: "text", gives: "text", params: [],
    validParams: noParams,
    run: (text) => text + SALT_TEXT,
  },
  shiftLeft: {
    needs: "number", gives: "number", params: ["n"],
    validParams: (p) => Number.isInteger(p?.n) && p.n >= 0 && p.n <= 31,
    run: (num, p) => (num << p.n) >>> 0,
  },
  shiftRight: {
    needs: "number", gives: "number", params: ["n"],
    validParams: (p) => Number.isInteger(p?.n) && p.n >= 0 && p.n <= 31,
    run: (num, p) => num >>> p.n,
  },
  and: {
    needs: "number", gives: "number", params: ["mask"],
    validParams: (p) => Number.isInteger(p?.mask) && p.mask >= 0 && p.mask <= 0xffffffff,
    run: (num, p) => (num & p.mask) >>> 0,
  },
  xor: {
    needs: "number", gives: "number", params: ["mask"],
    validParams: (p) => Number.isInteger(p?.mask) && p.mask >= 0 && p.mask <= 0xffffffff,
    run: (num, p) => (num ^ p.mask) >>> 0,
  },
  rotate: {
    needs: "number", gives: "number", params: ["n"],
    validParams: (p) => Number.isInteger(p?.n) && p.n >= 0 && p.n <= 31,
    run: (num, p) => ((num << p.n) | (num >>> (32 - p.n))) >>> 0,
  },
  fnv: {
    needs: "text", gives: "number", params: [],
    validParams: noParams,
    run: (text) => fnv1a32(text),
  },
};

// 32-bit FNV-1a. Turns text into a number for the bit ops. Not the real protection,
// that is the HMAC-SHA-256 step in runPipeline.
function fnv1a32(text) {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
}

// A step's own fields, without "op".
function paramsOf(step) {
  const { op, ...fields } = step;
  return fields;
}

// validParams wants undefined for "no params given", not an empty object.
const asParams = (fields) => (Object.keys(fields).length ? fields : undefined);

/**
 * Checks a pipeline against the allowlist, param ranges, step count, and the text/number
 * type rule. Does not run anything.
 * @param {Array<{op: string}>} steps
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validatePipeline(steps) {
  if (!Array.isArray(steps)) return { ok: false, reason: "pipeline must be an array of steps" };
  if (steps.length === 0) return { ok: false, reason: "pipeline must have at least one step" };
  if (steps.length > MAX_STEPS) return { ok: false, reason: `pipeline has more than ${MAX_STEPS} steps` };

  let form = "text"; // shape of the value right before this step
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object" || typeof step.op !== "string") {
      return { ok: false, reason: `step ${i} is not a valid step object` };
    }
    const def = Object.hasOwn(OPS, step.op) ? OPS[step.op] : undefined;
    if (!def) return { ok: false, reason: `step ${i} uses an unknown op "${step.op}"` };
    if (def.needs !== form) {
      return { ok: false, reason: `step ${i} (${step.op}) needs ${def.needs}, but the pipeline is ${form} at that point` };
    }
    const fields = paramsOf(step);
    const extra = Object.keys(fields).filter((k) => !def.params.includes(k));
    if (extra.length > 0) {
      return { ok: false, reason: `step ${i} (${step.op}) has unexpected field(s): ${extra.join(", ")}` };
    }
    if (!def.validParams(asParams(fields))) {
      return { ok: false, reason: `step ${i} (${step.op}) has invalid parameters` };
    }
    form = def.gives;
  }
  return { ok: true };
}

/**
 * Runs a validated pipeline on one word, then HMAC-SHA-256 under mixKey. mixKey must
 * already be its own CryptoKey, never the AES room key. Returns base64.
 * Throws on an invalid pipeline, a word over MAX_TEXT_CHARS, or a step that grows text
 * past MAX_TEXT_CHARS. Never truncates.
 * @param {Array<{op: string}>} steps
 * @param {string} word
 * @param {CryptoKey} mixKey
 * @returns {Promise<string>} base64 HMAC-SHA-256 tag
 */
export async function runPipeline(steps, word, mixKey) {
  const check = validatePipeline(steps);
  if (!check.ok) throw new Error(`invalid pipeline: ${check.reason}`);
  if (typeof word !== "string") throw new Error("word must be a string");
  if (word.length > MAX_TEXT_CHARS) throw new Error(`word is longer than ${MAX_TEXT_CHARS} characters`);

  let value = word;
  for (const step of steps) {
    const def = OPS[step.op];
    value = def.run(value, asParams(paramsOf(step)));
    if (def.gives === "text" && value.length > MAX_TEXT_CHARS) {
      throw new Error(`step "${step.op}" produced text longer than ${MAX_TEXT_CHARS} characters`);
    }
  }

  // Pipeline output never reaches the AES room key, only this one HMAC call.
  const finalText = typeof value === "number" ? String(value) : value;
  const tag = new Uint8Array(await subtle.sign("HMAC", mixKey, encoder.encode(finalText)));
  // Always 32 bytes, well under MAX_OUTPUT_BYTES. Nothing to check at run time.
  return btoa(String.fromCharCode(...tag));
}
