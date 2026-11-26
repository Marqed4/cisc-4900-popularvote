// Size limits the host sees. The server enforces them (clustering_controller.MAX_NOTES_CHARS and
// routes/sessions.py), this file only lets the page warn before a save fails. If you change
// MAX_HOST_NOTES_CHARS on the server, change NOTES_MAX_CHARS to match.
export const NOTES_MAX_CHARS = 30000;
export const PDF_MAX_PAGES = 50;

const SEPARATOR = "\n\n---\n\n";

export function notesCount(text, max = NOTES_MAX_CHARS) {
  const count = text.length;
  return { count, max, over: count > max, left: max - count };
}

// add extracted PDF text after the current notes. returns { fits, text, needed, room }.
// when it does not fit, text is the unchanged notes, so the caller can show a message and keep
// what the host already wrote instead of silently cutting the new text.
export function appendNotes(current, extracted, max = NOTES_MAX_CHARS) {
  const joined = current + (current.trim() ? SEPARATOR : "") + extracted;
  const room = Math.max(0, max - current.length - (current.trim() ? SEPARATOR.length : 0));
  if (joined.length > max) return { fits: false, text: current, needed: extracted.length, room };
  return { fits: true, text: joined, needed: extracted.length, room };
}
