import "./HostExpansion.css";

export default function ExpansionPanel({
  cluster,
  preview,
  selected,
  manualQuestion,
  onToggleQuestion,
  onManualChange,
  onManualSubmit,
}) {
  return (
    <div className="hd-expansion">
      <div className="hd-expansion-header">
        <span className="hd-expansion-label">Would you like to expand?</span>
      </div>

      <div className="hd-expansion-cols">

        <div className="hd-expansion-col hd-expansion-manual">
          <div className="hd-expansion-col-title">Manual entry</div>
          <textarea
            className="hd-manual-input"
            placeholder="Type a follow-up question…"
            value={manualQuestion ?? ""}
            onChange={e => onManualChange(cluster.id, e.target.value)}
            rows={3}
          />
          <button
            className="hd-btn-save"
            disabled={!manualQuestion?.trim()}
            onClick={() => onManualSubmit(cluster.id, manualQuestion)}
          >
            Submit
          </button>
        </div>

        <div className="hd-expansion-col hd-expansion-ai">
          <div className="hd-expansion-col-title">
            AI suggestions
            <span className="hd-expansion-col-hint">select to include</span>
          </div>

          {preview?.loading ? (
            <div className="hd-expansion-loading">
              {[1, 2, 3].map(n => (
                <div key={n} className="hd-expansion-skeleton" />
              ))}
            </div>
          ) : preview?.questions?.length ? (
            <ul className="hd-preview-list">
              {preview.questions.map((q, qi) => {
                const isSelected = selected.has(q);
                return (
                  <li
                    key={qi}
                    className={`hd-preview-item ${isSelected ? "selected" : ""}`}
                    onClick={() => onToggleQuestion(cluster.id, q)}
                  >
                    <span className="hd-preview-check">
                      {isSelected ? "✓" : "○"}
                    </span>
                    <span className="hd-preview-text">{q}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="hd-expansion-empty">
              Click "Preview Expansion" in the sidebar to load AI suggestions.
            </div>
          )}
        </div>

      </div>
    </div>
  );
}

// change checkmark to svn