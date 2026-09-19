import { jsPDF } from "jspdf";
import "./Summary.css";

export default function SummaryView({ clusters, answers, tags, submissionCount }) {

  function downloadMarkdown() {
    const lines = [];
    lines.push("# Session Summary");
    if (tags?.length) lines.push(`**Topics:** ${tags.join(", ")}`);
    lines.push(`${clusters.length} cluster${clusters.length !== 1 ? "s" : ""} · ${submissionCount} total submission${submissionCount !== 1 ? "s" : ""}`);
    lines.push("");

    clusters.forEach((cluster, i) => {
      const topQuestions = [...(cluster.questions ?? [])]
        .sort((a, b) => (b.upvoteCount ?? 0) - (a.upvoteCount ?? 0))
        .slice(0, 5);

      lines.push(`## ${i + 1}. ${cluster.representative_query}`);
      lines.push(`*${cluster.submission_count} submission${cluster.submission_count !== 1 ? "s" : ""}*`);
      lines.push("");

      if (answers[cluster.id]) {
        lines.push("**Host response**");
        lines.push(answers[cluster.id]);
        lines.push("");
      }
      if (cluster.selected_questions?.length) {
        lines.push("**AI recommended questions**");
        cluster.selected_questions.forEach(q => lines.push(`- ${q}`));
        lines.push("");
      }
      if (topQuestions.length) {
        lines.push("**Top questions**");
        topQuestions.forEach(q => {
          lines.push(`- ${q.text}${q.upvoteCount > 0 ? ` ▲ ${q.upvoteCount}` : ""}`);
        });
        lines.push("");
      }
      if (cluster.participant_answers?.length) {
        lines.push("**Participant answers**");
        cluster.participant_answers.forEach(a => lines.push(`- ${a}`));
        lines.push("");
      }
    });

    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "session-summary.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadPdf() {
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const margin = 48;
    const maxW = pageW - margin * 2;
    let y = 48;

    function checkPage(needed = 20) {
      if (y + needed > doc.internal.pageSize.getHeight() - 48) {
        doc.addPage();
        y = 48;
      }
    }

    function writeText(text, { fontSize = 11, bold = false, color = "#1c1917", indent = 0 } = {}) {
      doc.setFontSize(fontSize);
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setTextColor(color);
      const lines = doc.splitTextToSize(text, maxW - indent);
      lines.forEach(line => {
        checkPage();
        doc.text(line, margin + indent, y);
        y += fontSize * 1.45;
      });
    }

    // title
    writeText("Session Summary", { fontSize: 22, bold: true });
    y += 4;
    if (tags?.length) writeText(`Topics: ${tags.join(", ")}`, { fontSize: 10, color: "#78716c" });
    writeText(
      `${clusters.length} cluster${clusters.length !== 1 ? "s" : ""} · ${submissionCount} total submission${submissionCount !== 1 ? "s" : ""}`,
      { fontSize: 10, color: "#78716c" }
    );
    y += 16;

    clusters.forEach((cluster, i) => {
      const topQuestions = [...(cluster.questions ?? [])]
        .sort((a, b) => (b.upvoteCount ?? 0) - (a.upvoteCount ?? 0))
        .slice(0, 5);

      checkPage(40);
      // cluster number circle approximation, just bold number + query
      writeText(`${i + 1}. ${cluster.representative_query}`, { fontSize: 13, bold: true });
      writeText(`${cluster.submission_count} submission${cluster.submission_count !== 1 ? "s" : ""}`, { fontSize: 9, color: "#a8a29e" });
      y += 6;

      if (answers[cluster.id]) {
        writeText("Host response", { fontSize: 10, bold: true, color: "#44403c" });
        writeText(answers[cluster.id], { fontSize: 10, color: "#57534e", indent: 8 });
        y += 4;
      }

      if (cluster.selected_questions?.length) {
        writeText("AI recommended questions", { fontSize: 10, bold: true, color: "#44403c" });
        cluster.selected_questions.forEach(q => writeText(`• ${q}`, { fontSize: 10, color: "#57534e", indent: 8 }));
        y += 4;
      }

      if (topQuestions.length) {
        writeText("Top questions", { fontSize: 10, bold: true, color: "#44403c" });
        topQuestions.forEach(q => {
          const votes = q.upvoteCount > 0 ? `  ▲ ${q.upvoteCount}` : "";
          writeText(`• ${q.text}${votes}`, { fontSize: 10, color: "#57534e", indent: 8 });
        });
        y += 4;
      }

      if (cluster.participant_answers?.length) {
        writeText("Participant answers", { fontSize: 10, bold: true, color: "#44403c" });
        cluster.participant_answers.forEach(a => writeText(`• ${a}`, { fontSize: 10, color: "#57534e", indent: 8 }));
        y += 4;
      }

      y += 16;
      // divider
      checkPage();
      doc.setDrawColor("#e5e4e1");
      doc.line(margin, y, pageW - margin, y);
      y += 16;
    });

    doc.save("session-summary.pdf");
  }

  return (
    <div className="sv-root">
      <div className="sv-header">
        <div className="sv-title">Session Summary</div>
        {tags?.length > 0 && (
          <div className="sv-tags">
            {tags.map(t => <span key={t} className="sv-tag">{t}</span>)}
          </div>
        )}
        <div className="sv-meta">
          {clusters.length} cluster{clusters.length !== 1 ? "s" : ""} · {submissionCount} total submission{submissionCount !== 1 ? "s" : ""}
        </div>
        <div className="sv-download-row">
          <button className="sv-download-btn" onClick={downloadMarkdown}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 13v8m0 0l-3-3m3 3l3-3"/>
              <path d="M6.6 17A5 5 0 0 1 7 7h.1A7 7 0 0 1 19 9.5 4.5 4.5 0 0 1 17.5 18"/>
            </svg>
            Markdown
          </button>
          <button className="sv-download-btn" onClick={downloadPdf}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 13v8m0 0l-3-3m3 3l3-3"/>
              <path d="M6.6 17A5 5 0 0 1 7 7h.1A7 7 0 0 1 19 9.5 4.5 4.5 0 0 1 17.5 18"/>
            </svg>
            PDF
          </button>
        </div>
      </div>
      {/* rest of your clusters JSX unchanged */}
      <div className="sv-clusters">
        {clusters.map((cluster, i) => {
          const topQuestions = [...(cluster.questions ?? [])]
            .sort((a, b) => (b.upvoteCount ?? 0) - (a.upvoteCount ?? 0))
            .slice(0, 5);

          return (
            <div key={cluster.id} className="sv-cluster">
              <div className="sv-cluster-header">
                <span className="sv-cluster-num">{i + 1}</span>
                <div className="sv-cluster-info">
                  <div className="sv-cluster-query">{cluster.representative_query}</div>
                  <div className="sv-cluster-meta">
                    {cluster.submission_count} submission{cluster.submission_count !== 1 ? "s" : ""}
                  </div>
                </div>
              </div>
              {answers[cluster.id] && (
                <div className="sv-answer">
                  <div className="sv-answer-label">Host response</div>
                  <div className="sv-answer-text">{answers[cluster.id]}</div>
                </div>
              )}
              {cluster.selected_questions?.length > 0 && (
                <div className="sv-expansion-questions">
                  <div className="sv-questions-label">AI recommended questions</div>
                  <ul className="sv-questions-list">
                    {cluster.selected_questions.map((q, qi) => (
                      <li key={qi} className="sv-question-item"><span className="sv-question-text">{q}</span></li>
                    ))}
                  </ul>
                </div>
              )}
              {topQuestions.length > 0 && (
                <div className="sv-questions">
                  <div className="sv-questions-label">Top questions</div>
                  <ul className="sv-questions-list">
                    {topQuestions.map((q, qi) => (
                      <li key={qi} className="sv-question-item">
                        <span className="sv-question-text">{q.text}</span>
                        {q.upvoteCount > 0 && <span className="sv-upvote">▲ {q.upvoteCount}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {cluster.participant_answers?.length > 0 && (
                <div className="sv-participant-answers">
                  <div className="sv-questions-label">Participant answers</div>
                  <ul className="sv-questions-list">
                    {cluster.participant_answers.map((a, ai) => (
                      <li key={ai} className="sv-question-item">{a}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}