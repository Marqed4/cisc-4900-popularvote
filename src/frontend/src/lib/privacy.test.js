import { describe, it, expect } from "vitest";
import {
  PRIVACY_MODES, STANDARD, ENCRYPTED, PASSCODE,
  isMode, normalizeMode, modeInfo, isEncrypted, isPasscode,
} from "./privacy.js";

describe("PRIVACY_MODES", () => {
  it("lists the three modes least private first, standard as the default", () => {
    expect(PRIVACY_MODES.map(m => m.id)).toEqual([STANDARD, ENCRYPTED, PASSCODE]);
    expect(PRIVACY_MODES.map(m => m.label)).toEqual(["Standard", "Encrypted", "Passcode"]);
  });

  it("keeps every label one short word and every blurb one line, so they fit the picker and badge", () => {
    for (const m of PRIVACY_MODES) {
      expect(m.label).toMatch(/^\w+$/);
      expect(m.label.length).toBeLessThanOrEqual(10);
      expect(m.blurb.length).toBeLessThanOrEqual(60);
      expect(m.blurb).not.toContain("\n");
      expect(m.hint.length).toBeGreaterThan(m.blurb.length - 1);
    }
  });

  it("matches the ids the backend accepts", () => {
    expect([STANDARD, ENCRYPTED, PASSCODE]).toEqual(["standard", "encrypted", "passcode"]);
  });
});

describe("normalizeMode", () => {
  it("passes valid modes through", () => {
    for (const m of [STANDARD, ENCRYPTED, PASSCODE]) expect(normalizeMode(m)).toBe(m);
  });

  it("reads anything else as standard, never as something stronger", () => {
    for (const bad of [undefined, null, "", "secret", "hashed", "e2e", 1, true]) {
      expect(normalizeMode(bad)).toBe(STANDARD);
      expect(isMode(bad)).toBe(false);
    }
  });
});

describe("isEncrypted / isPasscode", () => {
  it("only standard is readable by the server", () => {
    expect(isEncrypted(STANDARD)).toBe(false);
    expect(isEncrypted(ENCRYPTED)).toBe(true);
    expect(isEncrypted(PASSCODE)).toBe(true);
    expect(isEncrypted(undefined)).toBe(false);
  });

  it("only passcode needs a typed code", () => {
    expect(isPasscode(PASSCODE)).toBe(true);
    expect(isPasscode(ENCRYPTED)).toBe(false);
    expect(isPasscode(STANDARD)).toBe(false);
  });
});

describe("modeInfo", () => {
  it("returns the label and hint for a mode, and standard for an unknown one", () => {
    expect(modeInfo(PASSCODE).label).toBe("Passcode");
    expect(modeInfo(ENCRYPTED).hint).toMatch(/cannot read questions/i);
    expect(modeInfo("bogus").label).toBe("Standard");
  });
});
