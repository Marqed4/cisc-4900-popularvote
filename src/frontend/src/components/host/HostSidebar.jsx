import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import "./HostSidebar.css";
import { API_BASE } from "../../lib/api.js";
import { NOTES_MAX_CHARS, PDF_MAX_PAGES, notesCount, appendNotes } from "../../lib/limits.js";

function QRDisplay({ url }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    if (!canvasRef.current || !url) return;
    QRCode.toCanvas(canvasRef.current, url, {
      width: 160,
      margin: 1,
      color: { dark: "#1c1917", light: "#ffffff" },
    });
  }, [url]);
  return <canvas ref={canvasRef} className="hd-qr-canvas" />;
}

export default function HostSidebar({
  code,
  phase,
  tags,
  tagInput,
  hostNotes,
  onNotesChange,
  onTagInput,
  onAddTag,
  onRemoveTag,
  onDeleteSession,
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notesText, setNotesText] = useState('');
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);
  const [notesError, setNotesError] = useState('');
  const fileInputRef = useRef(null);

  // sync when hostNotes prop loads from the API (useState initial value only runs once)
  useEffect(() => {
    setNotesText(hostNotes ?? '');
  }, [hostNotes]);

  const apiBase = API_BASE;

  function copyCode() { navigator.clipboard.writeText(code); }
  function copyLink() { navigator.clipboard.writeText(`${window.location.origin}?code=${code}`); }

  const sessionUrl = `${window.location.origin}?code=${code}`;
  const notes = notesCount(notesText);
  const canEditTags = ["OPEN", "RESULTS", "ENDED"].includes(phase);

  async function saveNotes(text) {
    setNotesSaving(true);
    setNotesError('');
    setNotesSaved(false);
    try {
      const res = await fetch(`${apiBase}/api/sessions/${code}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostNotes: text }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      onNotesChange?.(text);
      setNotesSaved(true);
      setTimeout(() => setNotesSaved(false), 2000);
    } catch (e) {
      setNotesError(e.message ?? 'Failed to save notes');
    } finally {
      setNotesSaving(false);
    }
  }

  async function handlePdfUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setNotesSaving(true);
    setNotesError('');
    setNotesSaved(false);
    try {
      const form = new FormData();
      form.append('pdf', file);
      const res = await fetch(`${apiBase}/api/sessions/${code}/notes`, { method: 'PATCH', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (!data.extracted) throw new Error('Could not extract text from PDF');
      // append extracted text into the textarea so the host can add more docs before saving.
      // if it would pass the limit, say so and keep the notes as they were
      const added = appendNotes(notesText, data.extracted);
      if (!added.fits) {
        setNotesError(`That PDF has ${added.needed.toLocaleString()} characters and only ${added.room.toLocaleString()} more fit. Shorten your notes or use a smaller PDF.`);
      } else {
        setNotesText(added.text);
      }
    } catch (e) {
      setNotesError(e.message ?? 'Failed to upload PDF');
    } finally {
      setNotesSaving(false);
      e.target.value = '';
    }
  }

  return (
    <aside className="hd-sidebar">
      <section className="hd-card">
        <div className="hd-card-title">Session Code</div>
        <div className="hd-code">{code}</div>
        <div className="hd-code-actions">
          <button className="hd-btn-ghost" onClick={copyCode}>Copy code</button>
          <button className="hd-btn-ghost" onClick={copyLink}>Copy link</button>
        </div>
        <QRDisplay url={sessionUrl} />
        <div className="hd-url">{sessionUrl}</div>
      </section>

      <section className="hd-card">
        <div className="hd-card-title">Tags</div>
        <div className="hd-tags">
          {tags.map(t => (
            <span key={t} className="hd-tag">
            {t}
            {canEditTags && (
              <button className="hd-tag-remove" onClick={() => onRemoveTag(t)}>×</button>
            )}
            </span>
          ))}
        </div>
        {canEditTags && (
          <div className="hd-tag-input-row">
            <input
              className="hd-tag-input"
              placeholder="ADD SESSION TAG "
              value={tagInput}
              onChange={e => onTagInput(e.target.value)}
              onKeyDown={onAddTag}
            />
            <button className="hd-tag-add-btn" onClick={() => onAddTag({ key: 'Enter', preventDefault: () => {} })}>+</button>
          </div>
        )}
      </section>

      {phase !== 'ENDED' && phase !== 'DELETED' && (
        <section className="hd-card">
          <div className="hd-card-title">Host Notes <span className="hd-notes-private">private</span></div>
          <p className="hd-notes-hint">Paste notes or add PDFs, each PDF is appended below. Up to {NOTES_MAX_CHARS.toLocaleString()} characters, and PDFs up to {PDF_MAX_PAGES} pages. Hit Save when done. Participants never see this.</p>
          <textarea
            className="hd-notes-textarea"
            placeholder="Paste speaker notes, context, FAQs…"
            value={notesText}
            onChange={e => setNotesText(e.target.value)}
            rows={5}
          />
          <div className={`hd-notes-count${notes.over ? ' hd-notes-count--over' : ''}`} aria-live="polite">
            {notes.count.toLocaleString()} / {notes.max.toLocaleString()}
            {notes.over && ` · ${(-notes.left).toLocaleString()} over, shorten it to save`}
          </div>
          <div className="hd-notes-actions">
            <button className="hd-btn-ghost" onClick={() => fileInputRef.current?.click()} disabled={notesSaving}>
              {notesSaving ? 'Extracting…' : '↑ Add PDF'}
            </button>
            <button className="hd-btn-ghost" onClick={() => saveNotes(notesText)} disabled={notesSaving || notes.over}>
              {notesSaving ? 'Saving…' : notesSaved ? '✓ Saved' : 'Save notes'}
            </button>
          </div>
          <input ref={fileInputRef} type="file" accept="application/pdf" className="hd-notes-file-input" onChange={handlePdfUpload} />
          {notesError && <div className="hd-notes-error">{notesError}</div>}
        </section>
      )}

      {phase === "ENDED" && (
        <section className="hd-card hd-actions">
          <div className="hd-card-title">Session</div>
          <div className="hd-ended-msg">This session has ended.</div>
          {confirmDelete ? (
            <>
              <div className="hd-ended-msg">Delete it for good? The summary and all questions are removed.</div>
              <button className="hd-btn-end" onClick={onDeleteSession}>Yes, delete</button>
              <button className="hd-btn-ghost hd-btn-ghost--full" onClick={() => setConfirmDelete(false)}>Keep it</button>
            </>
          ) : (
            <button className="hd-btn-end" onClick={() => setConfirmDelete(true)}>Delete session</button>
          )}
        </section>
      )}

    </aside>
  );
}