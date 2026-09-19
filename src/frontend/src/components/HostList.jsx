import Summary from "./Summary";
import "./HostCluster.css";
import React from "react";

function ExpandableQuestions({ questions }) {
  const [expanded, setExpanded] = React.useState(false);
  if (!questions?.length) return null;
  return (
    <div className="hd-cluster-questions">
      <button className="hd-cluster-toggle" onClick={() => setExpanded(e => !e)}>
        {expanded
          ? `Hide ${questions.length} question${questions.length !== 1 ? 's' : ''} ▲`
          : `Show ${questions.length} question${questions.length !== 1 ? 's' : ''} ▼`}
      </button>
      {expanded && (
        <ul className="hd-questions-list">
          {questions.map((q, qi) => {
            const qText = typeof q === 'string' ? q : (q.text ?? '');
            const qVotes = typeof q === 'string' ? 0 : (q.upvoteCount ?? 0);
            return (
              <li key={qi} className="hd-question-item">
                <span className="hd-question-text">{qText}</span>
                {qVotes > 0 && <span className="hd-question-upvotes">▲ {qVotes}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function getClusterUpvotes(cluster) {
  if (!cluster.questions?.length) return 0;
  return cluster.questions.reduce((sum, q) => {
    return sum + (typeof q === 'string' ? 0 : (q.upvoteCount ?? 0));
  }, 0);
}

export default function HostList({
  phase,
  clusters,
  submissions = [],
  submissionCount,
  answers,
  editingAnswer,
  suggestedAnswers = {},
  onDeleteCluster,
  onSetEditingAnswer,
  onAnswerChange,
  onSaveAnswer,
  onUseSuggestion,
}) {
  const [sortBy, setSortBy] = React.useState("original");
  
  // Check if the session has ended. Display Summary if it has.
  if (phase === "ENDED" && clusters.length > 0) {
    return (
      <Summary
        clusters={clusters}
        answers={answers}
        tags={[]}
        submissionCount={submissionCount}
      />
    );
  }

  if (phase === "OPEN" || phase === "CLOSED") {
    const hasEnough = submissionCount >= 3;
    return (
      <div className="hd-waiting">
        <div className="hd-waiting-title">
          {phase === "OPEN" ? "Waiting for submissions…" : "Ready to cluster."}
        </div>

        {submissions.length > 0 ? (
          <ul className="hd-submissions-feed">
            {submissions.map(s => (
              <li key={s.id} className="hd-submission-feed-item">{s.content}</li>
            ))}
          </ul>
        ) : (
          <p className="hd-waiting-sub">
            {phase === "OPEN"
              ? "Share the code with your audience. Submissions will appear here."
              : "No submissions yet."
            }
          </p>
        )}

        {submissions.length > 0 && (
          <p className="hd-waiting-sub" style={{ marginTop: "0.75rem" }}>
            {hasEnough
              ? `${submissionCount} submission${submissionCount !== 1 ? "s" : ""} ~ looking good, ready to cluster.`
              : `${submissionCount} submission${submissionCount !== 1 ? "s" : ""} so far.`
            }
          </p>
        )}
      </div>
    );
  }

  if (phase === "CLUSTERING") {
    return (
      <div className="hd-waiting">
        <div className="hd-waiting-title">Analysing submissions…</div>
        <p className="hd-waiting-sub">This may take a few seconds.</p>
      </div>
    );
  }

  if (phase === "EXPANDING") {
    return (
      <div className="hd-clusters">
        <div className="hd-round2-banner">
          <div className="hd-round2-title">Round 2 is open</div>
          <p className="hd-round2-sub">Participants can now submit follow-up questions. Close submissions when ready, then cluster.</p>
        </div>
        {clusters.length > 0 && (
          <>
            <div className="hd-clusters-header">
              <span className="hd-clusters-title">Round 1 results</span>
            </div>
            {clusters.map((cluster, i) => (
              <div key={cluster.id} className="hd-cluster hd-cluster--readonly">
                <div className="hd-cluster-top">
                  <span className="hd-cluster-num">{i + 1}</span>
                  <div className="hd-cluster-info">
                    <div className="hd-cluster-query">{cluster.representative_query}</div>
                    <div className="hd-cluster-count">{cluster.submission_count} submission{cluster.submission_count !== 1 ? "s" : ""}</div>
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    );
  }

  if ((phase === "RESULTS" || phase === "ENDED") && clusters.length > 0) {
    const sortedClusters = sortBy === "popular"
      ? [...clusters].sort((a, b) => getClusterUpvotes(b) - getClusterUpvotes(a))
      : clusters;

    return (
      <div className="hd-clusters">
        <div className="hd-clusters-header">
          <span className="hd-clusters-title">
            {clusters.length} cluster{clusters.length !== 1 ? "s" : ""}
          </span>
          <div className="hd-clusters-header-right">
            <span className="hd-clusters-sub">
              {submissionCount} total submissions
            </span>
            <div className="hd-sort-toggle">
              <button
                className={`hd-sort-btn${sortBy === "original" ? " hd-sort-btn--active" : ""}`}
                onClick={() => setSortBy("original")}
              >Original</button>
              <button
                className={`hd-sort-btn${sortBy === "popular" ? " hd-sort-btn--active" : ""}`}
                onClick={() => setSortBy("popular")}
              >By popularity</button>
            </div>
          </div>
        </div>

        {sortedClusters.map((cluster, i) => {
          return (
            <div key={cluster.id} className="hd-cluster">
              <div className="hd-cluster-top">
                <div className="hd-cluster-left">
                  <div className="hd-cluster-info">
                    <div className="hd-cluster-query">
                      <span className="hd-cluster-num">Q{i + 1}.</span> {cluster.representative_query}
                    </div>
                    <div className="hd-cluster-count">
                      {cluster.submission_count} submission{cluster.submission_count !== 1 ? "s" : ""}
                    </div>
                  </div>
                </div>
                {phase === "RESULTS" && (
                  <button
                    className="hd-cluster-delete"
                    onClick={() => onDeleteCluster(cluster.id)}
                    title="Delete cluster"
                  >×</button>
                )}
              </div>

              <ExpandableQuestions questions={cluster.questions} />

              {suggestedAnswers[cluster.id] && !answers[cluster.id] && phase === "RESULTS" && (
                <div className="hd-suggestion">
                  <div className="hd-suggestion-label">✦ Suggested answer <span className="hd-suggestion-source">grounded in your notes</span></div>
                  <div className="hd-suggestion-text">{suggestedAnswers[cluster.id]}</div>
                  <div className="hd-suggestion-actions">
                    <button className="hd-btn-use-suggestion" onClick={() => onUseSuggestion?.(cluster.id, suggestedAnswers[cluster.id])}>
                      Use this
                    </button>
                    <span className="hd-suggestion-hint">or write your own below</span>
                  </div>
                </div>
              )}

              <div className="hd-cluster-answer-area">
                {editingAnswer === cluster.id ? (
                  <>
                    <textarea
                      className="hd-answer-input"
                      placeholder="Write a response to this cluster…"
                      value={answers[cluster.id] ?? ""}
                      onChange={e => onAnswerChange(cluster.id, e.target.value)}
                      rows={3}
                    />
                    <div className="hd-answer-btns">
                      <button className="hd-btn-save" onClick={() => onSaveAnswer(cluster.id)}>Save</button>
                      <button className="hd-btn-cancel" onClick={() => onSetEditingAnswer(null)}>Cancel</button>
                    </div>
                  </>
                ) : answers[cluster.id] ? (
                  <div className="hd-answer-display has-answer">
                    <span className="hd-answer-text">{answers[cluster.id]}</span>
                    {phase === "RESULTS" && (
                      <button className="hd-btn-edit-answer" onClick={() => onSetEditingAnswer(cluster.id)}>
                        Edit
                      </button>
                    )}
                  </div>
                ) : (
                  <div
                    className="hd-answer-display no-answer"
                    onClick={() => phase === "RESULTS" && onSetEditingAnswer(cluster.id)}
                  >
                    Click to write a response…
                  </div>
                )}
              </div>

            </div>
          );
        })}
      </div>
    );
  }

  return null;
}