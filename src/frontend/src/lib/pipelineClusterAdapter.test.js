import { describe, it, expect } from "vitest";
import { hashSubmissionContent, clusterHashedSubmissions } from "./pipelineClusterAdapter.js";

const SIMPLE_PIPE = [{ op: "substring", from: 0, to: 4 }, { op: "fnv" }];

async function key(secret = "test-mix-key") {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
}

describe("hashSubmissionContent", () => {
  it("hashes every word and keeps the same word count", async () => {
    const mixKey = await key();
    const hashed = await hashSubmissionContent("what is the capital of France", SIMPLE_PIPE, mixKey);
    expect(hashed.split(" ")).toHaveLength(6);
  });

  it("only uses hex characters, so clustering.js's own tokenize keeps every token whole", async () => {
    const mixKey = await key();
    const hashed = await hashSubmissionContent("hello world", SIMPLE_PIPE, mixKey);
    for (const token of hashed.split(" ")) {
      expect(token).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("is deterministic: the same word always hashes to the same token", async () => {
    const mixKey = await key();
    const a = await hashSubmissionContent("same word same word", SIMPLE_PIPE, mixKey);
    const [w1, w2, w3, w4] = a.split(" ");
    expect(w1).toBe(w3);
    expect(w2).toBe(w4);
  });

  it("ignores punctuation the same way clustering.js's tokenize does", async () => {
    const mixKey = await key();
    const a = await hashSubmissionContent("hello, world!", SIMPLE_PIPE, mixKey);
    const b = await hashSubmissionContent("hello world", SIMPLE_PIPE, mixKey);
    expect(a).toBe(b);
  });
});

describe("clusterHashedSubmissions", () => {
  it("rejects an invalid pipeline before hashing or clustering anything", async () => {
    const mixKey = await key();
    await expect(
      clusterHashedSubmissions([{ id: 1, content: "hi" }], [{ op: "madeUpOp" }], mixKey),
    ).rejects.toThrow(/invalid pipeline/);
  });

  it("groups submissions whose hashed words match, same as clusterQuestions would on plain text", async () => {
    const mixKey = await key();
    const submissions = [
      { id: 1, content: "what time does the store close" },
      { id: 2, content: "what time does the store close" },
      { id: 3, content: "completely unrelated question about pizza toppings" },
    ];
    const clusters = await clusterHashedSubmissions(submissions, SIMPLE_PIPE, mixKey);
    expect(clusters.length).toBeGreaterThan(0);
    const total = clusters.reduce((sum, c) => sum + c.submissionCount, 0);
    expect(total).toBe(3);
  });

  it("returns empty for no submissions, same as clusterQuestions", async () => {
    const mixKey = await key();
    expect(await clusterHashedSubmissions([], SIMPLE_PIPE, mixKey)).toEqual([]);
  });
});
