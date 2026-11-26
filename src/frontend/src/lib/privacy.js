// privacy.js: the three privacy modes, and every word the UI uses for them.
// Mirrors src/backend/privacy.py. The database, the API and this file all say
// "standard", "encrypted" and "passcode", so there is one vocabulary and no flag pairs.

export const STANDARD = "standard";
export const ENCRYPTED = "encrypted";
export const PASSCODE = "passcode";

// order matters: the picker shows them top to bottom, least private first.
// `blurb` is one line for the picker, `hint` is the longer tooltip for the history badge.
export const PRIVACY_MODES = [
  {
    id: STANDARD,
    label: "Standard",
    blurb: "AI groups questions and suggests answers.",
    hint: "The server can read questions, so AI can group them and suggest answers.",
  },
  {
    id: ENCRYPTED,
    label: "Encrypted",
    blurb: "Only the room can read questions. No AI.",
    hint: "End-to-end encrypted. The server cannot read questions. Keys are shared automatically while the host is online.",
  },
  {
    id: PASSCODE,
    label: "Passcode",
    blurb: "Encrypted, unlocked with a code you share.",
    hint: "End-to-end encrypted. Everyone needs the passcode the host shares. The server never stores it.",
  },
];

export function isMode(value) {
  return value === STANDARD || value === ENCRYPTED || value === PASSCODE;
}

// anything unknown reads as standard, which is also what the server does with a missing value.
export function normalizeMode(value) {
  return isMode(value) ? value : STANDARD;
}

export function modeInfo(value) {
  const id = normalizeMode(value);
  return PRIVACY_MODES.find(m => m.id === id);
}

// can the server read the questions? only in standard mode.
export function isEncrypted(value) {
  return normalizeMode(value) !== STANDARD;
}

// does the room key come from a typed passcode instead of the host's browser?
export function isPasscode(value) {
  return normalizeMode(value) === PASSCODE;
}
