import { describe, it, expect } from "vitest";
import { NOTES_MAX_CHARS, notesCount, appendNotes } from "./limits.js";

describe("notesCount", () => {
  it("counts characters against the limit", () => {
    expect(notesCount("hello")).toEqual({ count: 5, max: NOTES_MAX_CHARS, over: false, left: NOTES_MAX_CHARS - 5 });
  });

  it("is not over at exactly the limit, and is over by one character past it", () => {
    expect(notesCount("a".repeat(NOTES_MAX_CHARS)).over).toBe(false);
    const past = notesCount("a".repeat(NOTES_MAX_CHARS + 1));
    expect(past.over).toBe(true);
    expect(past.left).toBe(-1);
  });
});

describe("appendNotes", () => {
  it("adds PDF text after the notes with a divider", () => {
    const out = appendNotes("my notes", "from the pdf", 1000);
    expect(out.fits).toBe(true);
    expect(out.text).toBe("my notes\n\n---\n\nfrom the pdf");
  });

  it("adds no divider when the notes are empty or only spaces", () => {
    expect(appendNotes("", "from the pdf", 1000).text).toBe("from the pdf");
    expect(appendNotes("  \n ", "from the pdf", 1000).text).toBe("  \n from the pdf");
  });

  it("fits when the result is exactly the limit", () => {
    const out = appendNotes("", "a".repeat(100), 100);
    expect(out.fits).toBe(true);
    expect(out.text).toHaveLength(100);
  });

  it("refuses one character past the limit and returns the notes unchanged", () => {
    const out = appendNotes("keep me", "a".repeat(100), 100);
    expect(out.fits).toBe(false);
    expect(out.text).toBe("keep me");
    expect(out.needed).toBe(100);
  });

  it("reports how much room is left, counting the divider", () => {
    const out = appendNotes("x".repeat(40), "a".repeat(100), 100);
    expect(out.fits).toBe(false);
    expect(out.room).toBe(100 - 40 - "\n\n---\n\n".length);
  });

  it("never reports negative room", () => {
    expect(appendNotes("x".repeat(500), "a", 100).room).toBe(0);
  });
});
