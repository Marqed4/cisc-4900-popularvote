import { useState } from "react";
import "./PasscodeCard.css";

// The decryption code for the hashed identity tier. A card in the page flow on purpose, not a
// modal or an overlay, so nothing sits on top of the room. It has two jobs:
//   - locked: this browser doesn't have the code yet (host reopening the room, or a participant
//     joining). a 6 character box unlocks the questions. the code is never stored, so this is
//     asked again on every visit.
//   - passcode set (host only): the host typed or generated the code this visit, and needs to be
//     able to read it out to participants. `open` shows it big, collapsed it is a thin bar with a
//     Show button. it only lives in this tab's memory.
export default function PasscodeCard({ role = "host", passcode, open, onToggle, locked, error, busy, onUnlock }) {
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(passcode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked. the code is on screen, they can read it off.
    }
  }

  if (locked) {
    return (
      <form
        className="pv-passcode"
        onSubmit={e => { e.preventDefault(); onUnlock(input); }}
      >
        <p className="pv-passcode-eyebrow">Locked session</p>
        <p className="pv-passcode-note">
          {role === "host"
            ? "Enter the 6 character decryption code you got when you started this session."
            : "Enter the 6 character decryption code from the host. It is separate from the join code, and it is what unlocks the questions."}
        </p>
        <div className="pv-passcode-actions">
          <input
            className="pv-passcode-input"
            value={input}
            onChange={e => setInput(e.target.value.toUpperCase())}
            maxLength={8}
            placeholder="······"
            autoFocus
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            aria-label="Decryption code"
            aria-invalid={!!error}
          />
          <button className="pv-passcode-btn pv-passcode-btn--primary" type="submit" disabled={busy || !input.trim()}>
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </div>
        {error && <p className="pv-passcode-error" role="alert">{error}</p>}
      </form>
    );
  }

  if (!passcode) return null;

  if (!open) {
    return (
      <div className="pv-passcode pv-passcode--bar">
        <span className="pv-passcode-eyebrow">Decryption code hidden</span>
        <button className="pv-passcode-btn" onClick={onToggle}>Show code</button>
      </div>
    );
  }

  return (
    <section className="pv-passcode" aria-live="polite">
      <p className="pv-passcode-eyebrow">Decryption code</p>
      <div className="pv-passcode-code" aria-label={`Decryption code: ${passcode.split("").join(" ")}`}>
        {passcode.split("").map((ch, i) => <span key={i} className="pv-passcode-char">{ch}</span>)}
      </div>
      <p className="pv-passcode-note">
        Give this to participants along with the join code. Everyone types it to read and send
        questions. It isn't stored anywhere, so there's no reset: lose it and the questions stay
        scrambled for good.
      </p>
      <div className="pv-passcode-actions">
        <button className="pv-passcode-btn" onClick={copy}>{copied ? "Copied ✓" : "Copy code"}</button>
        <button className="pv-passcode-btn pv-passcode-btn--primary" onClick={onToggle}>I've saved it</button>
      </div>
    </section>
  );
}
