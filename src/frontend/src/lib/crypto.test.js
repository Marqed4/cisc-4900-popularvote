import { describe, it, expect } from "vitest";
import {
  PASSCODE_LENGTH,
  generatePasscode,
  normalizePasscode,
  deriveRoomKeyFromPasscode,
  makeKeyCheck,
  verifyKeyCheck,
  encryptText,
  decryptText,
  generateRoomKey,
} from "./crypto.js";

const ALPHABET = /^[0-9A-HJKMNP-TV-Z]+$/; // Crockford base32, no I L O U

describe("generatePasscode", () => {
  it("makes PASSCODE_LENGTH characters from the Crockford alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePasscode();
      expect(code).toHaveLength(PASSCODE_LENGTH);
      expect(code).toMatch(ALPHABET);
    }
  });

  it("does not hand out the same code twice in a row", () => {
    const codes = new Set(Array.from({ length: 50 }, generatePasscode));
    expect(codes.size).toBeGreaterThan(45);
  });
});

describe("normalizePasscode", () => {
  it("ignores case, spaces and dashes", () => {
    expect(normalizePasscode("ab3-d9z")).toBe("AB3D9Z");
    expect(normalizePasscode(" ab3 d9z ")).toBe("AB3D9Z");
  });

  it("folds the lookalikes: O to 0, I and L to 1", () => {
    expect(normalizePasscode("OIL0AB")).toBe("0110AB");
  });

  it("returns null when the length is wrong", () => {
    expect(normalizePasscode("ABC12")).toBeNull();
    expect(normalizePasscode("ABC1234")).toBeNull();
    expect(normalizePasscode("")).toBeNull();
  });

  it("returns null for characters outside the alphabet", () => {
    expect(normalizePasscode("ABC12U")).toBeNull(); // U is not in Crockford
    expect(normalizePasscode("ABC12!")).toBeNull();
  });

  it("returns null for null and undefined instead of throwing", () => {
    expect(normalizePasscode(null)).toBeNull();
    expect(normalizePasscode(undefined)).toBeNull();
  });

  it("accepts every code generatePasscode can make", () => {
    for (let i = 0; i < 50; i++) {
      const code = generatePasscode();
      expect(normalizePasscode(code)).toBe(code);
    }
  });
});

describe("deriveRoomKeyFromPasscode", () => {
  it("derives the same key from the same passcode and session on any call", async () => {
    const a = await deriveRoomKeyFromPasscode("ABC123", "SESS01");
    const b = await deriveRoomKeyFromPasscode("ABC123", "SESS01");

    const { ciphertext, nonce } = await encryptText(a, "same key?");
    expect(await decryptText(b, ciphertext, nonce)).toBe("same key?");
  });

  it("derives an AES-GCM key that is extractable for wrapping", async () => {
    const key = await deriveRoomKeyFromPasscode("ABC123", "SESS01");

    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.extractable).toBe(true);
  });

  it("derives a different key for a different passcode", async () => {
    const right = await deriveRoomKeyFromPasscode("ABC123", "SESS01");
    const wrong = await deriveRoomKeyFromPasscode("ABC124", "SESS01");

    const { ciphertext, nonce } = await encryptText(right, "secret");
    await expect(decryptText(wrong, ciphertext, nonce)).rejects.toThrow();
  });

  it("derives a different key for a different session code (the salt)", async () => {
    const one = await deriveRoomKeyFromPasscode("ABC123", "SESS01");
    const two = await deriveRoomKeyFromPasscode("ABC123", "SESS02");

    const { ciphertext, nonce } = await encryptText(one, "secret");
    await expect(decryptText(two, ciphertext, nonce)).rejects.toThrow();
  });
});

describe("key check", () => {
  it("verifies with the key that made it", async () => {
    const key = await deriveRoomKeyFromPasscode("ABC123", "SESS01");
    const check = await makeKeyCheck(key);

    expect(await verifyKeyCheck(key, check)).toBe(true);
  });

  it("is a JSON string holding ciphertext and nonce, nothing readable", async () => {
    const key = await generateRoomKey();
    const check = await makeKeyCheck(key);

    const parsed = JSON.parse(check);
    expect(Object.keys(parsed).sort()).toEqual(["ciphertext", "nonce"]);
    expect(check).not.toContain("popularvote-key-check");
  });

  it("rejects a key derived from a mistyped passcode", async () => {
    const real = await deriveRoomKeyFromPasscode("ABC123", "SESS01");
    const typo = await deriveRoomKeyFromPasscode("ABC12Z", "SESS01");

    expect(await verifyKeyCheck(typo, await makeKeyCheck(real))).toBe(false);
  });

  it("returns false for garbage instead of throwing", async () => {
    const key = await generateRoomKey();

    expect(await verifyKeyCheck(key, "not json")).toBe(false);
    expect(await verifyKeyCheck(key, "{}")).toBe(false);
    expect(await verifyKeyCheck(key, null)).toBe(false);
  });
});
