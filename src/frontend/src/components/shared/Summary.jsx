import "./Summary.css";

function plural(n, word) {
  return `${n} ${word}${n !== 1 ? "s" : ""}`;
}

// Questions can arrive as plain strings or as { text, upvoteCount } objects.
function normalizeQuestion(q) {
  return typeof q === "string"
    ? { text: q, upvoteCount: 0 }
    : { text: q.text ?? "", upvoteCount: q.upvoteCount ?? 0 };
}

function topQuestionsOf(cluster) {
  return (cluster.questions ?? [])
    .map(normalizeQuestion)
    .sort((a, b) => b.upvoteCount - a.upvoteCount)
    .slice(0, 5);
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SummaryView({ clusters, answers, tags, submissionCount, title = "Session Summary" }) {
  const countLine = `${plural(clusters.length, "cluster")} · ${plural(submissionCount, "total submission")}`;

  function downloadMarkdown() {
    const lines = [];
    lines.push(`# ${title}`);
    if (tags?.length) lines.push(`**Topics:** ${tags.join(", ")}`);
    lines.push(countLine);
    lines.push("");

    clusters.forEach((cluster, i) => {
      lines.push(`## ${i + 1}. ${cluster.representative_query}`);
      lines.push(`*${plural(cluster.submission_count, "submission")}*`);
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
      const top = topQuestionsOf(cluster);
      if (top.length) {
        lines.push("**Top questions**");
        top.forEach(q => lines.push(`- ${q.text}${q.upvoteCount > 0 ? ` ▲ ${q.upvoteCount}` : ""}`));
        lines.push("");
      }
      if (cluster.participant_answers?.length) {
        lines.push("**Participant answers**");
        cluster.participant_answers.forEach(a => lines.push(`- ${a}`));
        lines.push("");
      }
    });

    saveBlob(new Blob([lines.join("\n")], { type: "text/markdown" }), "session-summary.md");
  }

  async function downloadPdf() {
    // loaded on demand so jsPDF stays out of the main bundle
    const { jsPDF } = await import("jspdf");

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
      const wrapped = doc.splitTextToSize(text, maxW - indent);
      wrapped.forEach(line => {
        checkPage();
        doc.text(line, margin + indent, y);
        y += fontSize * 1.45;
      });
    }

    writeText(title, { fontSize: 22, bold: true });
    y += 4;
    if (tags?.length) writeText(`Topics: ${tags.join(", ")}`, { fontSize: 10, color: "#78716c" });
    writeText(countLine, { fontSize: 10, color: "#78716c" });
    y += 16;

    clusters.forEach((cluster, i) => {
      checkPage(40);
      writeText(`${i + 1}. ${cluster.representative_query}`, { fontSize: 13, bold: true });
      writeText(plural(cluster.submission_count, "submission"), { fontSize: 9, color: "#a8a29e" });
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

      const top = topQuestionsOf(cluster);
      if (top.length) {
        writeText("Top questions", { fontSize: 10, bold: true, color: "#44403c" });
        top.forEach(q => {
          // the built-in PDF font cannot draw the triangle glyph, so spell the votes out
          const votes = q.upvoteCount > 0 ? `  (${plural(q.upvoteCount, "vote")})` : "";
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
        <div className="sv-title">{title}</div>
        {tags?.length > 0 && (
          <div className="sv-tags">
            {tags.map(t => <span key={t} className="sv-tag">{t}</span>)}
          </div>
        )}
        <div className="sv-meta">{countLine}</div>
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

      <div className="sv-clusters">
        {clusters.map((cluster, i) => {
          const top = topQuestionsOf(cluster);

          return (
            <div key={cluster.id} className="sv-cluster">
              <div className="sv-cluster-header">
                <span className="sv-cluster-num">{i + 1}</span>
                <div className="sv-cluster-info">
                  <div className="sv-cluster-query">{cluster.representative_query}</div>
                  <div className="sv-cluster-meta">{plural(cluster.submission_count, "submission")}</div>
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
              {top.length > 0 && (
                <div className="sv-questions">
                  <div className="sv-questions-label">Top questions</div>
                  <ul className="sv-questions-list">
                    {top.map((q, qi) => (
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
