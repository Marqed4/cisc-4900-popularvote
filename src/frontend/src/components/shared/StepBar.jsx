import { useState } from "react";
import { STEPS, stepIndex } from "../../lib/steps.js";
import "./StepBar.css";

// One strip that answers "where are we" and "what do I do next".
// Hosts get the next-step buttons here (they used to live at the bottom of the sidebar).
// Participants get the same strip without buttons, so both sides see the same four steps.
//   guide    { hint, primary, secondary } from hostGuide(), or just a hint string for participants
//   onAction called with an action id ("group", "close", "end", ...)
//   busy     true while any action is running, so nothing can be double-clicked
export default function StepBar({ phase, hint, primary = null, secondary = [], onAction, busy = false, error = "" }) {
  const current = stepIndex(phase);
  const [asking, setAsking] = useState(null); // an action waiting on "are you sure"

  function run(action) {
    if (action.confirm) setAsking(action);
    else onAction?.(action.id);
  }

  function confirmRun(action) {
    setAsking(null);
    onAction?.(action.id);
  }

  return (
    <section className="sb-step" aria-label="Session progress">
      <ol className="sb-step-track">
        {STEPS.map((name, i) => (
          <li
            key={name}
            className={`sb-step-item ${i < current ? "is-done" : ""} ${i === current ? "is-current" : ""}`}
            aria-current={i === current ? "step" : undefined}
          >
            <span className="sb-step-dot">{i < current ? "✓" : i + 1}</span>
            <span className="sb-step-name">{name}</span>
          </li>
        ))}
      </ol>

      <div className="sb-step-row">
        <p className="sb-step-hint">{hint}</p>

        {(primary || secondary.length > 0) && !asking && (
          <div className="sb-step-actions">
            {secondary.map(a => (
              <button key={a.id} className="sb-step-btn sb-step-btn--quiet" onClick={() => run(a)} disabled={busy || a.disabled}>
                {a.label}
              </button>
            ))}
            {primary && (
              <button className="sb-step-btn sb-step-btn--main" onClick={() => run(primary)} disabled={busy || primary.disabled}>
                {busy ? primary.busy : primary.label}
              </button>
            )}
          </div>
        )}

        {asking && (
          <div className="sb-step-confirm" role="alertdialog" aria-label="Confirm">
            <span>{asking.confirm}</span>
            <button className="sb-step-btn sb-step-btn--quiet" onClick={() => setAsking(null)}>Cancel</button>
            <button className="sb-step-btn sb-step-btn--danger" onClick={() => confirmRun(asking)}>Yes, {asking.label.toLowerCase()}</button>
          </div>
        )}
      </div>

      {error && <div className="sb-step-error" role="alert">{error}</div>}
    </section>
  );
}
