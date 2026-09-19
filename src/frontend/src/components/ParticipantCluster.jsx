import { useState } from "react";
import "./ParticipantCluster.css";

const MAX_CHARS = 500;

function ClusterCard({ cluster, answer, myTexts, upvotes, followups, phase, onUpvote, onSubmitToCluster }) {
  const [expanded, setExpanded] = useState(false);
  const [addingQuestion, setAddingQuestion] = useState(false);
  const [clusterInput, setClusterInput] = useState("");
  const [submitLoading, setSubmitLoading] = useState(false);
  // chip feedback: track which chips are loading or confirmed
  const [loadingChip, setLoadingChip] = useState(null);   // chip text currently submitting
  const [submittedChips, setSubmittedChips] = useState(new Set()); // chips already submitted

  const questions = cluster.questions ?? [];
  const isEnded = phase === "ENDED";
  const remaining = MAX_CHARS - clusterInput.length;

  async function handleClusterSubmit() {
    const trimmed = clusterInput.trim();
    if (!trimmed) return;
    setSubmitLoading(true);
    await onSubmitToCluster(cluster.id, trimmed);
    setClusterInput("");
    setAddingQuestion(false);
    setSubmitLoading(false);
  }

  async function handleChipClick(q) {
    if (loadingChip || submittedChips.has(q)) return;
    setLoadingChip(q);
    await onSubmitToCluster(cluster.id, q);
    setSubmittedChips(prev => new Set([...prev, q]));
    setLoadingChip(null);
  }

  return (
    <div className={`pd-cluster ${questions.some(q => myTexts.has(q.text)) ? "pd-cluster--mine" : ""}`}>
      <div className="pd-cluster-top">
        <div className="pd-cluster-left">
          <span className="pd-cluster-badge">{cluster.submission_count} submission{cluster.submission_count !== 1 ? "s" : ""}</span>
          {questions.some(q => myTexts.has(q.text)) && (
            <span className="pd-cluster-mine-tag">your question</span>
          )}
        </div>
      </div>

      <div className="pd-cluster-query">{cluster.representative_query}</div>

      {answer && (
        <div className="pd-cluster-answer">
          <span className="pd-answer-label">Host response</span>
          <p className="pd-answer-text">{answer}</p>
        </div>
      )}

      {answer && followups?.length > 0 && !isEnded && (
        <div className="pd-followups">
          <div className="pd-followups-label">Want to dig deeper? Tap a question to ask it:</div>
          <ul className="pd-followups-list">
            {followups.map((q, i) => {
              const isLoading = loadingChip === q;
              const isSubmitted = submittedChips.has(q);
              return (
                <li key={i}>
                  <button
                    className={`pd-followup-chip ${isSubmitted ? "pd-followup-chip--done" : ""} ${isLoading ? "pd-followup-chip--loading" : ""}`}
                    onClick={() => handleChipClick(q)}
                    disabled={isLoading || isSubmitted}
                  >
                    {isLoading ? "Submitting…" : isSubmitted ? "✓ Submitted" : q}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {questions.length > 0 && (
        <>
          <button
            className="pd-expand-btn"
            onClick={() => setExpanded(v => !v)}
          >
            {expanded ? "Hide questions ▲" : `Show ${questions.length} question${questions.length !== 1 ? "s" : ""} ▼`}
          </button>

          {expanded && (
            <ul className="pd-questions-list">
              {questions.map((q, i) => {
                const isOwn = myTexts.has(q.text);
                const voted = upvotes[q.text];
                return (
                  <li key={i} className={`pd-question-item ${isOwn ? "pd-question-item--own" : ""}`}>
                    <span className="pd-question-text">
                      {isOwn && <span className="pd-own-dot" />}
                      {q.text}
                    </span>
                    {!isOwn && !isEnded && (
                      <button
                        className={`pd-upvote-btn ${voted ? "pd-upvote-btn--voted" : ""}`}
                        onClick={() => onUpvote(q.text)}
                        title={voted ? "Remove upvote" : "Upvote"}
                      >
                        ▲ {q.upvoteCount ?? 0}
                      </button>
                    )}
                    {isEnded && q.upvoteCount > 0 && (
                      <span className="pd-upvote-count">▲ {q.upvoteCount}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {!isEnded && (
        <>
          {addingQuestion ? (
            <div className="pd-cluster-input-area">
              <textarea
                className="pd-textarea pd-textarea--sm"
                placeholder="Add your question to this cluster…"
                value={clusterInput}
                onChange={e => setClusterInput(e.target.value.slice(0, MAX_CHARS))}
                rows={3}
                disabled={submitLoading}
              />
              <div className="pd-textarea-footer">
                <span className={`pd-charcount ${remaining <= 80 ? "pd-charcount--warn" : ""}`}>
                  {remaining} remaining
                </span>
                <div style={{ display: "flex", gap: "8px" }}>
                  <button className="pd-btn-ghost" onClick={() => { setAddingQuestion(false); setClusterInput(""); }}>
                    Cancel
                  </button>
                  <button
                    className="pd-btn-primary"
                    onClick={handleClusterSubmit}
                    disabled={!clusterInput.trim() || submitLoading}
                  >
                    {submitLoading ? "Submitting…" : "Submit"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button className="pd-add-q-btn" onClick={() => setAddingQuestion(true)}>
              + Add my question here
            </button>
          )}
        </>
      )}
    </div>
  );
}

export default function ParticipantClusterList({
  phase,
  clusters,
  answers,
  myTexts,
  upvotes,
  followups,
  onUpvote,
  onSubmitToCluster,
}) {
  if (!clusters.length) {
    return (
      <div className="pd-empty">
        <div className="pd-empty-title">No clusters yet.</div>
      </div>
    );
  }

  return (
    <div className="pd-clusters">
      <div className="pd-clusters-header">
        <span className="pd-clusters-title">
          {clusters.length} cluster{clusters.length !== 1 ? "s" : ""}
        </span>
      </div>
      {clusters.map(cluster => (
        <ClusterCard
          key={cluster.id}
          cluster={cluster}
          /*This way answers from the socket will 
          match cluster.id from the DB, even if one is a number and the other is a string.
          This should let them appear instantly when the host answers a cluster, 
          without needing to refresh or wait for another update.
          */
          answer={answers[String(cluster.id)]}
          myTexts={myTexts}
          upvotes={upvotes}
          followups={followups?.[cluster.id]}
          phase={phase}
          onUpvote={onUpvote}
          onSubmitToCluster={onSubmitToCluster}
        />
      ))}
    </div>
  );
}