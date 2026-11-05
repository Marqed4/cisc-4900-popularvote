import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getDeviceId, sessionUserHash } from "./deviceId.js";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("getDeviceId", () => {
  it("makes an id once and keeps handing out the same one", () => {
    const first = getDeviceId();

    expect(first).toBeTruthy();
    expect(getDeviceId()).toBe(first);
    expect(localStorage.getItem("pv_device_id")).toBe(first);
  });

  it("falls back to a fresh id when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });

    expect(getDeviceId()).toBeTruthy();
  });
});

describe("sessionUserHash", () => {
  it("is 32 hex characters", async () => {
    expect(await sessionUserHash("ABC123")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is stable for one device inside one session", async () => {
    expect(await sessionUserHash("ABC123")).toBe(await sessionUserHash("ABC123"));
  });

  it("differs between sessions on the same device, so rooms can't be linked", async () => {
    expect(await sessionUserHash("ABC123")).not.toBe(await sessionUserHash("XYZ789"));
  });

  it("differs between devices in the same session", async () => {
    const mine = await sessionUserHash("ABC123");
    localStorage.setItem("pv_device_id", "some-other-device");

    expect(await sessionUserHash("ABC123")).not.toBe(mine);
  });

  it("does not contain the raw device id", async () => {
    const id = getDeviceId();

    expect(await sessionUserHash("ABC123")).not.toContain(id.replace(/-/g, "").slice(0, 8));
  });
});
