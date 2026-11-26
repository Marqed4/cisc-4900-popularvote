// steps.js: the plain-language view of a session's phase.
// The server has seven phases. People think in four steps, so this maps one onto the other
// and holds every word the host and participants see about "where are we" and "what next".
// Pure functions only, so the wording can be tested without rendering anything.

export const STEPS = ["Collect", "Group", "Answer", "Wrap up"];

const PHASE_STEP = {
  OPEN: 0,
  CLOSED: 0,
  CLUSTERING: 1,
  RESULTS: 2,
  EXPANDING: 2,
  ENDED: 3,
};

// the small badge next to the title. one friendly word per phase.
const PHASE_LABEL = {
  OPEN: "Collecting",
  CLOSED: "Closed",
  CLUSTERING: "Grouping",
  RESULTS: "Answering",
  EXPANDING: "Follow-ups",
  ENDED: "Ended",
};

export function stepIndex(phase) {
  return PHASE_STEP[phase] ?? 0;
}

export function phaseLabel(phase) {
  return PHASE_LABEL[phase] ?? phase;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// what the host should do next. `primary` is the one obvious button, `secondary` are quieter
// ones. an action has an id the host screen maps to a handler, a label, and (for the ones that
// cannot be undone) a `confirm` sentence the bar asks before running it.
export function hostGuide(phase, { submissionCount = 0, encrypted = false } = {}) {
  switch (phase) {
    case "OPEN":
      return {
        hint: submissionCount === 0
          ? "Share the code. Questions show up here as people send them."
          : `${plural(submissionCount, "question")} in. Group them whenever you are ready.`,
        primary: { id: "group", label: "Group questions", busy: "Grouping…", disabled: submissionCount === 0 },
        secondary: [{ id: "close", label: "Stop accepting questions", busy: "Closing…" }],
      };
    case "CLOSED":
      return {
        hint: "Questions are closed. Group them into topics next.",
        primary: { id: "group", label: "Group questions", busy: "Grouping…", disabled: submissionCount === 0 },
        secondary: [],
      };
    case "CLUSTERING":
      return { hint: "Grouping questions into topics. This takes a few seconds.", primary: null, secondary: [] };
    case "RESULTS":
      return {
        hint: "Answer each topic below. Participants see your answers as you save them.",
        primary: {
          id: "end", label: "Finish session", busy: "Finishing…",
          confirm: "Finish for everyone? Nobody can ask or vote after this. You can still download the summary.",
        },
        secondary: [
          { id: "regroup", label: "Regroup", busy: "Grouping…" },
          ...(encrypted ? [] : [{ id: "followups", label: "Ask for follow-ups", busy: "Opening…" }]),
        ],
      };
    case "EXPANDING":
      return {
        hint: "Follow-up questions are open. Stop accepting when you have enough, then group them.",
        primary: { id: "group", label: "Group follow-ups", busy: "Grouping…", disabled: submissionCount === 0 },
        secondary: [{ id: "close", label: "Stop accepting questions", busy: "Closing…" }],
      };
    case "ENDED":
      return { hint: "This session has ended. The summary below can be downloaded.", primary: null, secondary: [] };
    default:
      return { hint: "", primary: null, secondary: [] };
  }
}

// the same idea for someone who only watches: where are we, and what happens next.
export function participantGuide(phase) {
  switch (phase) {
    case "OPEN":
      return "Send a question. The host groups similar ones and answers them here.";
    case "CLOSED":
      return "Questions are closed. The host is about to group them.";
    case "CLUSTERING":
      return "Grouping questions into topics. This page updates by itself.";
    case "RESULTS":
      return "Questions are grouped. Vote on the ones you care about. Answers appear as the host writes them.";
    case "EXPANDING":
      return "The host opened follow-up questions. Ask what is still unclear.";
    case "ENDED":
      return "This session has ended.";
    default:
      return "";
  }
}
