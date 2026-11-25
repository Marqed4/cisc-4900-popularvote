// pipelineClusterAdapter.js: feeds hashed words into clustering.js without editing it.
// clustering.js is only imported and called here, never modified.

import { validatePipeline, runPipeline } from "./pipeline.js";
import { clusterQuestions } from "./clustering.js";

// Same word boundary rule clustering.js's own tokenize uses, kept here so clustering.js
// does not need to export anything new. A hashed submission is handed to clusterQuestions
// as plain content, same as any other submission.
const WORD_RE = /[a-z0-9']+/g;

function wordsOf(text) {
  return (text.toLowerCase().match(WORD_RE) || []);
}

// base64 has +, /, =, and uppercase letters, none of which survive clustering.js's own
// tokenize regex. Hex only uses 0-9a-f, so the hashed tokens pass through untouched.
function base64ToHex(b64) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hashes every word in one submission's content, joined back with spaces. Same word
 * count and order as the input, each word replaced by its hex pipeline tag.
 * @param {string} content real submission text
 * @param {Array<{op:string}>} steps a validated pipeline
 * @param {CryptoKey} mixKey from derivePipelineMixKey
 * @returns {Promise<string>}
 */
export async function hashSubmissionContent(content, steps, mixKey) {
  const hashed = [];
  for (const word of wordsOf(content)) {
    hashed.push(base64ToHex(await runPipeline(steps, word, mixKey)));
  }
  return hashed.join(" ");
}

/**
 * Clusters submissions by their hashed words instead of plain text. Validates the
 * pipeline up front, hashes every submission, then calls clusterQuestions unchanged.
 * @param {Array<{id: string|number, content: string}>} submissions
 * @param {Array<{op:string}>} steps public hashing pipeline, same for everyone
 * @param {CryptoKey} mixKey from derivePipelineMixKey
 * @param {object} [options] passed straight through to clusterQuestions
 */
export async function clusterHashedSubmissions(submissions, steps, mixKey, options) {
  const check = validatePipeline(steps);
  if (!check.ok) throw new Error(`invalid pipeline: ${check.reason}`);
  const hashed = [];
  for (const sub of submissions) {
    hashed.push({ ...sub, content: await hashSubmissionContent(sub.content, steps, mixKey) });
  }
  return clusterQuestions(hashed, options);
}
