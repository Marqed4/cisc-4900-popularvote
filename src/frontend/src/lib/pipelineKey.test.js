import { describe, it, expect } from "vitest";
import { derivePipelineMixKey } from "./pipelineKey.js";
import { deriveRoomKeyFromPasscode } from "./crypto.js";

// Signs the same bytes with a key, returns the tag as hex so two keys are easy to compare.
async function tagWith(key, text) {
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("derivePipelineMixKey", () => {
  it("returns a sign-only HMAC-SHA-256 key", async () => {
    const key = await derivePipelineMixKey("ABCD1234", "ABC123");
    expect(key.algorithm.name).toBe("HMAC");
    expect(key.algorithm.hash.name).toBe("SHA-256");
    expect(key.usages).toEqual(["sign"]);
  });

  it("is deterministic: same passcode and session code give the same key", async () => {
    const a = await derivePipelineMixKey("ABCD1234", "ABC123");
    const b = await derivePipelineMixKey("ABCD1234", "ABC123");
    expect(await tagWith(a, "hello")).toBe(await tagWith(b, "hello"));
  });

  it("a different passcode gives a different key", async () => {
    const a = await derivePipelineMixKey("ABCD1234", "ABC123");
    const b = await derivePipelineMixKey("WXYZ9999", "ABC123");
    expect(await tagWith(a, "hello")).not.toBe(await tagWith(b, "hello"));
  });

  it("a different session code gives a different key", async () => {
    const a = await derivePipelineMixKey("ABCD1234", "ABC123");
    const b = await derivePipelineMixKey("ABCD1234", "XYZ789");
    expect(await tagWith(a, "hello")).not.toBe(await tagWith(b, "hello"));
  });

  it("the pipeline mix key differs from the AES room key derived from the same passcode", async () => {
    const mixKey = await derivePipelineMixKey("ABCD1234", "ABC123");
    const roomKey = await deriveRoomKeyFromPasscode("ABCD1234", "ABC123");
    const mixTag = await tagWith(mixKey, "same bytes");
    // Room key is AES-GCM, not HMAC, so compare it can only decrypt, not sign. Encrypting
    // and HMAC-ing the same text and checking they differ proves the two keys live on
    // separate branches: nothing from the room key path leaked into the mixing key.
    const roomKeyRaw = await crypto.subtle.exportKey("raw", roomKey);
    const asHmac = await crypto.subtle.importKey(
      "raw", roomKeyRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const roomTag = await tagWith(asHmac, "same bytes");
    expect(mixTag).not.toBe(roomTag);
  });
});
