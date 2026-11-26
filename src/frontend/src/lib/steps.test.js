import { describe, it, expect } from "vitest";
import { STEPS, stepIndex, phaseLabel, hostGuide, participantGuide } from "./steps.js";

const PHASES = ["OPEN", "CLOSED", "CLUSTERING", "RESULTS", "EXPANDING", "ENDED"];

describe("stepIndex", () => {
  it("folds the six live phases into four steps, in order", () => {
    expect(STEPS).toHaveLength(4);
    expect(stepIndex("OPEN")).toBe(0);
    expect(stepIndex("CLOSED")).toBe(0);
    expect(stepIndex("CLUSTERING")).toBe(1);
    expect(stepIndex("RESULTS")).toBe(2);
    expect(stepIndex("EXPANDING")).toBe(2);
    expect(stepIndex("ENDED")).toBe(3);
  });

  it("falls back to the first step for an unknown phase", () => {
    expect(stepIndex("???")).toBe(0);
  });
});

describe("phaseLabel", () => {
  it("never shows the raw phase name or the word cluster", () => {
    for (const p of PHASES) {
      expect(phaseLabel(p)).not.toBe(p);
      expect(phaseLabel(p).toLowerCase()).not.toContain("cluster");
    }
  });
});

describe("hostGuide", () => {
  it("has one obvious button, and no jargon, in every phase", () => {
    for (const p of PHASES) {
      const g = hostGuide(p, { submissionCount: 5 });
      const text = [g.hint, g.primary?.label, ...g.secondary.map(a => a.label)].join(" ").toLowerCase();
      expect(text).not.toMatch(/cluster|trigger|expand|curator/);
    }
  });

  it("while collecting, the main action is grouping and it waits for a question", () => {
    expect(hostGuide("OPEN", { submissionCount: 0 }).primary).toMatchObject({ id: "group", disabled: true });
    expect(hostGuide("OPEN", { submissionCount: 3 }).primary).toMatchObject({ id: "group", disabled: false });
    expect(hostGuide("OPEN", { submissionCount: 3 }).secondary.map(a => a.id)).toEqual(["close"]);
  });

  it("counts questions with the right plural", () => {
    expect(hostGuide("OPEN", { submissionCount: 1 }).hint).toContain("1 question in");
    expect(hostGuide("OPEN", { submissionCount: 4 }).hint).toContain("4 questions in");
  });

  it("finishing the session asks first", () => {
    expect(hostGuide("RESULTS").primary.confirm).toBeTruthy();
  });

  it("offers follow-ups only when the server can read the questions", () => {
    const ids = enc => hostGuide("RESULTS", { encrypted: enc }).secondary.map(a => a.id);
    expect(ids(false)).toEqual(["regroup", "followups"]);
    expect(ids(true)).toEqual(["regroup"]);
  });

  it("shows nothing to press while grouping or after the session ends", () => {
    for (const p of ["CLUSTERING", "ENDED"]) {
      const g = hostGuide(p);
      expect(g.primary).toBeNull();
      expect(g.secondary).toEqual([]);
    }
  });
});

describe("participantGuide", () => {
  it("says something useful in every phase", () => {
    for (const p of PHASES) expect(participantGuide(p).length).toBeGreaterThan(10);
  });
});
