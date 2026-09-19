import { useState } from "react";
import "./ParticipantInput.css";

const MAX_CHARS = 500;

export default function ParticipantInput({
  phase,
  submissions,
  submittedCount,
  inClusterCount,
  submitLoading,
  error,
  onSubmit,
  onDelete,
}) {
  const [text, setText] = useState("");
  const isOpen = phase === "OPEN";
  const remaining = MAX_CHARS - text.length;
  const nearLimit = remaining <= 80;

  function handleSubmit() {
    const trimmed = text.trim();
    if (!trimmed || !isOpen) return;
    onSubmit(trimmed);
    setText("");
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
  }

  return (
    <div className="pd-input-shell">
      <div className="pd-card">
        <div className="pd-card-header">
          <span className="pd-card-title">
            {isOpen ? "Submit a question" : "Submissions closed"}
          </span>
          <div className="pd-stats-row">
            <div className="pd-stat">
              <span className="pd-stat-num">{submittedCount}</span>
              <span className="pd-stat-label">submitted</span>
            </div>
            <div className="pd-stat-divider" />
            <div className="pd-stat">
              <span className="pd-stat-num">{inClusterCount}</span>
              <span className="pd-stat-label">in cluster</span>
            </div>
          </div>
        </div>

        {isOpen ? (
          <>
            <textarea
              className="pd-textarea"
              placeholder="Ask your question anonymously…"
              value={text}
              onChange={e => setText(e.target.value.slice(0, MAX_CHARS))}
              onKeyDown={handleKeyDown}
              rows={4}
              disabled={submitLoading}
            />
            <div className="pd-textarea-footer">
              <span className={`pd-charcount ${nearLimit ? "pd-charcount--warn" : ""}`}>
                {remaining} remaining
              </span>
              <button
                className="pd-btn-primary"
                onClick={handleSubmit}
                disabled={!text.trim() || submitLoading}
              >
                {submitLoading ? "Submitting…" : "Submit"}
              </button>
            </div>
          </>
        ) : (
          <p className="pd-closed-msg">
            The host has closed the submission window. Your questions have been received.
          </p>
        )}

        {error && <div className="pd-error">{error}</div>}
      </div>

      {submissions.length > 0 && (
        <div className="pd-card pd-card--submissions">
          <div className="pd-card-title pd-card-title--sm">Your submissions</div>
          <ul className="pd-submissions-list">
            {submissions.map(s => (
              <li key={s.id} className="pd-submission-item">
                <span className="pd-submission-text">{s.text}</span>
                {isOpen && (
                  <button
                    className="pd-delete-btn"
                    onClick={() => onDelete(s.id)}
                    title="Delete"
                  >×</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}