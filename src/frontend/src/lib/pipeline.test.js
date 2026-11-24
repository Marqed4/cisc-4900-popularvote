import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  validatePipeline, runPipeline,
  MAX_STEPS, MAX_TEXT_CHARS, MAX_OUTPUT_BYTES, MAX_REPEAT_N,
} from "./pipeline.js";

// A guarded pipeline must never be able to run code. This test reads the source text
// itself, not just the behavior, so a future edit that sneaks in eval or new Function
// fails here even if no other test would have noticed.
describe("no eval, no dynamic code", () => {
  it("the source file never calls eval or new Function", () => {
    // vitest runs with process.cwd() at src/frontend, so this path is stable regardless of
    // how the test environment (jsdom) rewrites import.meta.url.
    const source = readFileSync(join(process.cwd(), "src/lib/pipeline.js"), "utf8");
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/new\s+Function\s*\(/);
  });
});

async function hmacKey(secret = "test-mix-key") {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

const SUBSTRING_PIPE = [{ op: "substring", from: 0, to: 3 }];
const FULL_NUMERIC_PIPE = [
  { op: "substring", from: 0, to: 4 },
  { op: "fnv" },
  { op: "shiftLeft", n: 3 },
  { op: "xor", mask: 0xff },
  { op: "rotate", n: 5 },
  { op: "and", mask: 1020 },
];

describe("validatePipeline: shape and limits", () => {
  it("accepts a simple one-step text pipeline", () => {
    expect(validatePipeline(SUBSTRING_PIPE)).toEqual({ ok: true });
  });

  it("accepts a full pipeline that crosses from text to number", () => {
    expect(validatePipeline(FULL_NUMERIC_PIPE)).toEqual({ ok: true });
  });

  it("rejects a non-array", () => {
    expect(validatePipeline("not an array").ok).toBe(false);
    expect(validatePipeline(null).ok).toBe(false);
    expect(validatePipeline(undefined).ok).toBe(false);
  });

  it("rejects an empty pipeline", () => {
    expect(validatePipeline([]).ok).toBe(false);
  });

  it(`rejects more than ${MAX_STEPS} steps`, () => {
    const tooMany = Array.from({ length: MAX_STEPS + 1 }, () => ({ op: "salt" }));
    const result = validatePipeline(tooMany);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/steps/);
  });

  it(`accepts exactly ${MAX_STEPS} steps`, () => {
    const exactly = Array.from({ length: MAX_STEPS }, () => ({ op: "salt" }));
    expect(validatePipeline(exactly)).toEqual({ ok: true });
  });

  it("rejects a step that is not an object", () => {
    expect(validatePipeline(["substring"]).ok).toBe(false);
    expect(validatePipeline([null]).ok).toBe(false);
  });

  it("rejects an op that is not on the allowlist", () => {
    const result = validatePipeline([{ op: "toLowerCase" }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unknown op/);
  });

  it("rejects eval and new Function as op names", () => {
    expect(validatePipeline([{ op: "eval" }]).ok).toBe(false);
    expect(validatePipeline([{ op: "new Function" }]).ok).toBe(false);
  });

  it("rejects constructor and __proto__ as op names, with the unknown-op reason", () => {
    for (const op of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const result = validatePipeline([{ op }]);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/unknown op/);
    }
  });

  it("rejects a step that carries a field the op does not use", () => {
    const result = validatePipeline([{ op: "repeat", n: 2, evil: "x" }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unexpected field/);
  });

  it("rejects an op with no params at all that still gets an extra field", () => {
    expect(validatePipeline([{ op: "salt", extra: 1 }]).ok).toBe(false);
    expect(validatePipeline([{ op: "fnv", extra: 1 }]).ok).toBe(false);
  });
});

describe("validatePipeline: per-op parameter ranges", () => {
  it("substring: rejects from >= to", () => {
    expect(validatePipeline([{ op: "substring", from: 4, to: 4 }]).ok).toBe(false);
    expect(validatePipeline([{ op: "substring", from: 5, to: 2 }]).ok).toBe(false);
  });

  it("substring: rejects a negative from", () => {
    expect(validatePipeline([{ op: "substring", from: -1, to: 3 }]).ok).toBe(false);
  });

  it(`substring: rejects to beyond ${MAX_TEXT_CHARS}`, () => {
    expect(validatePipeline([{ op: "substring", from: 0, to: MAX_TEXT_CHARS + 1 }]).ok).toBe(false);
  });

  it("substring: rejects non-integer params", () => {
    expect(validatePipeline([{ op: "substring", from: 0.5, to: 3 }]).ok).toBe(false);
    expect(validatePipeline([{ op: "substring", from: "0", to: 3 }]).ok).toBe(false);
  });

  it(`repeat: accepts 1..${MAX_REPEAT_N} and rejects outside it`, () => {
    expect(validatePipeline([{ op: "repeat", n: 1 }]).ok).toBe(true);
    expect(validatePipeline([{ op: "repeat", n: MAX_REPEAT_N }]).ok).toBe(true);
    expect(validatePipeline([{ op: "repeat", n: 0 }]).ok).toBe(false);
    expect(validatePipeline([{ op: "repeat", n: MAX_REPEAT_N + 1 }]).ok).toBe(false);
  });

  it("shiftLeft/shiftRight/rotate: n must be 0..31", () => {
    for (const op of ["shiftLeft", "shiftRight", "rotate"]) {
      expect(validatePipeline([{ op: "fnv" }, { op, n: 0 }]).ok).toBe(true);
      expect(validatePipeline([{ op: "fnv" }, { op, n: 31 }]).ok).toBe(true);
      expect(validatePipeline([{ op: "fnv" }, { op, n: -1 }]).ok).toBe(false);
      expect(validatePipeline([{ op: "fnv" }, { op, n: 32 }]).ok).toBe(false);
    }
  });

  it("and/xor: mask must be 0..0xffffffff", () => {
    for (const op of ["and", "xor"]) {
      expect(validatePipeline([{ op: "fnv" }, { op, mask: 0 }]).ok).toBe(true);
      expect(validatePipeline([{ op: "fnv" }, { op, mask: 0xffffffff }]).ok).toBe(true);
      expect(validatePipeline([{ op: "fnv" }, { op, mask: -1 }]).ok).toBe(false);
      expect(validatePipeline([{ op: "fnv" }, { op, mask: 0x100000000 }]).ok).toBe(false);
    }
  });
});

describe("validatePipeline: text/number type rule", () => {
  it("rejects a numeric op before fnv turns text into a number", () => {
    const result = validatePipeline([{ op: "shiftLeft", n: 1 }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/needs number/);
  });

  it("rejects substring after fnv (already a number)", () => {
    const result = validatePipeline([{ op: "fnv" }, { op: "substring", from: 0, to: 2 }]);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/needs text/);
  });

  it("rejects repeat after fnv", () => {
    expect(validatePipeline([{ op: "fnv" }, { op: "repeat", n: 2 }]).ok).toBe(false);
  });

  it("rejects salt after fnv", () => {
    expect(validatePipeline([{ op: "fnv" }, { op: "salt" }]).ok).toBe(false);
  });

  it("rejects a second fnv (text already consumed into a number)", () => {
    expect(validatePipeline([{ op: "fnv" }, { op: "fnv" }]).ok).toBe(false);
  });
});

describe("runPipeline: limits enforced at run time, never truncated", () => {
  it("rejects a word longer than the text limit before running anything", async () => {
    const key = await hmacKey();
    const longWord = "x".repeat(MAX_TEXT_CHARS + 1);
    await expect(runPipeline(SUBSTRING_PIPE, longWord, key)).rejects.toThrow(/longer than/);
  });

  it("accepts a word exactly at the text limit", async () => {
    const key = await hmacKey();
    const word = "x".repeat(MAX_TEXT_CHARS);
    await expect(runPipeline([{ op: "substring", from: 0, to: 3 }], word, key)).resolves.toBeTruthy();
  });

  it("rejects a pipeline whose repeat step would push text past the limit", async () => {
    const key = await hmacKey();
    // 40 chars repeated 8 times is 320, over MAX_TEXT_CHARS
    const word = "x".repeat(40);
    const pipe = [{ op: "repeat", n: MAX_REPEAT_N }];
    await expect(runPipeline(pipe, word, key)).rejects.toThrow(/longer than/);
  });

  it("rejects running an invalid pipeline instead of trying to run it", async () => {
    const key = await hmacKey();
    await expect(runPipeline([{ op: "madeUpOp" }], "hello", key)).rejects.toThrow(/invalid pipeline/);
  });

  it("output is always a 32-byte HMAC-SHA-256 tag, well under MAX_OUTPUT_BYTES", async () => {
    const key = await hmacKey();
    const tag = await runPipeline(SUBSTRING_PIPE, "hello", key);
    const bytes = Uint8Array.from(atob(tag), (c) => c.charCodeAt(0));
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(bytes.byteLength).toBe(32);
  });
});

describe("runPipeline: determinism and domain separation", () => {
  it("is deterministic: same steps, same word, same key gives the same tag", async () => {
    const key = await hmacKey("same-key");
    const a = await runPipeline(FULL_NUMERIC_PIPE, "hello", key);
    const b = await runPipeline(FULL_NUMERIC_PIPE, "hello", key);
    expect(a).toBe(b);
  });

  it("a different word gives a different tag", async () => {
    const key = await hmacKey("same-key");
    const a = await runPipeline(SUBSTRING_PIPE, "hello", key);
    const b = await runPipeline(SUBSTRING_PIPE, "world", key);
    expect(a).not.toBe(b);
  });

  it("a different mixing key (a stand-in for a different passcode) gives a different tag", async () => {
    const keyA = await hmacKey("passcode-A-derived-key");
    const keyB = await hmacKey("passcode-B-derived-key");
    const a = await runPipeline(SUBSTRING_PIPE, "hello", keyA);
    const b = await runPipeline(SUBSTRING_PIPE, "hello", keyB);
    expect(a).not.toBe(b);
  });

  it("a different pipeline on the same word and key gives a different tag", async () => {
    const key = await hmacKey("same-key");
    const a = await runPipeline(SUBSTRING_PIPE, "hello", key);
    const b = await runPipeline([{ op: "substring", from: 0, to: 3 }, { op: "salt" }], "hello", key);
    expect(a).not.toBe(b);
  });
});
