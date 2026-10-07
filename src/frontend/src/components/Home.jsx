import { useState, useEffect, useRef } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { DefaultBackgrounds } from '../assets/backgrounds/index.js';
import "./Home.css";

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function MoonIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
function SunIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function BackgroundPicker({ current, onSelect, onClose, darkMode }) {
  const filtered = Object.entries(DefaultBackgrounds).filter(([key]) =>
    darkMode ? key.startsWith("night_") : key.startsWith("day_")
  );
  return (
    <div className="pv-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="pv-modal pv-bg-picker">
        <button className="pv-modal-close" onClick={onClose}>×</button>
        <h2>Choose Background</h2>
        <div className="pv-bg-grid">
          {filtered.map(([key, src]) => (
            <button key={key} className={`pv-bg-option ${current === key ? "active" : ""}`}
              onClick={() => { onSelect(key); onClose(); }}>
              <img src={src} alt={key} />
              <span>{key.replace(/^(day_|night_)/, '').replace(/([A-Z])/g, ' $1').trim()}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function InstructionsModal({ onClose }) {
  return (
    <div className="pv-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="pv-modal">
        <button className="pv-modal-close" onClick={onClose}>×</button>
        <h2>How Popular Vote Works</h2>
        <div className="pv-modal-section">
          <h3>For Hosts</h3>
          <p>Create a session and share the code. Close submissions, trigger AI clustering, write responses, and end the session.</p>
        </div>
        <div className="pv-modal-section">
          <h3>For Participants</h3>
          <p>Join via code, link, or QR scan. Submit questions anonymously, upvote others, and read the host's answers.</p>
        </div>
        <div className="pv-modal-section">
          <h3>Privacy</h3>
          <p>All questions are anonymous. Sign in to keep your session history, otherwise it stays local to this browser.</p>
        </div>
      </div>
    </div>
  );
}

function QRScanner({ onScan, onError }) {
  const [status, setStatus] = useState("starting");
  const isRunningRef = useRef(false);
  const doneRef = useRef(false);

  useEffect(() => {
    const scanner = new Html5Qrcode("pv-qr-reader");
    scanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 200, height: 200 } },
      (text) => {
        if (doneRef.current) return;
        let code = text.trim().toUpperCase();
        try { const c = new URL(text).searchParams.get("code"); if (c) code = c.toUpperCase(); } catch {}
        if (/^[A-Z0-9]{6}$/.test(code)) {
          doneRef.current = true;
          scanner.stop().catch(() => {}).finally(() => onScan(code));
        }
      },
      () => {}
    )
    .then(() => { isRunningRef.current = true; setStatus("scanning"); })
    .catch(() => { setStatus("error"); onError?.("Camera access denied."); });

    return () => { if (isRunningRef.current) { isRunningRef.current = false; scanner.stop().catch(() => {}); } };
  }, []);

  return (
    <div className="pv-qr-wrap">
      <div id="pv-qr-reader" className="pv-qr-reader" />
      {status === "starting" && <p className="pv-qr-hint">Starting camera…</p>}
      {status === "scanning" && <p className="pv-qr-hint">Aim at the QR code on screen.</p>}
    </div>
  );
}

function JoinFlow({ onJoin }) {
  const [mode, setMode]   = useState("code"); // code | link | qr
  const [code, setCode]   = useState("");
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("code");
    if (c && /^[A-Z0-9]{6}$/i.test(c)) setCode(c.toUpperCase());
  }, []);

  function handleCodeChange(e) {
    setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6));
    setError("");
  }

  function handleLinkPaste(e) {
    const val = e.target.value;
    setError("");
    try {
      const c = new URL(val).searchParams.get("code");
      if (c && /^[A-Z0-9]{6}$/i.test(c)) { setCode(c.toUpperCase()); setMode("code"); }
    } catch {}
  }

  async function handleJoin(targetCode) {
    const target = (targetCode ?? code).trim().toUpperCase();
    if (target.length !== 6) { setError("Codes are 6 characters."); return; }
    setJoining(true);
    try {
      const apiBase = import.meta.env.VITE_API_URL ?? "";
      const res = await fetch(`${apiBase}/api/sessions/${target}/join`, { method: "POST" });
      if (!res.ok) { const b = await res.json().catch(() => ({})); setError(b.error ?? "Session not found."); return; }
      onJoin(target);
    } catch { setError("Could not reach server."); }
    finally { setJoining(false); }
  }

  return (
    <div className="pv-join-flow">
      {mode === "code" && (
        <div className="pv-join-row">
          <input
            className={`pv-code-input ${error ? "pv-code-input--error" : ""}`}
            placeholder="enter code"
            value={code}
            onChange={handleCodeChange}
            onKeyDown={e => e.key === "Enter" && code.length === 6 && handleJoin()}
            maxLength={6}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className="pv-btn-join"
            disabled={code.length !== 6 || joining}
            onClick={() => handleJoin()}
          >
            {joining ? "Joining…" : "Join →"}
          </button>
        </div>
      )}

      {mode === "link" && (
        <div className="pv-join-row">
          <input
            className="pv-link-input"
            placeholder="Paste session link…"
            onChange={handleLinkPaste}
            autoFocus
          />
          <button className="pv-btn-join" disabled={code.length !== 6 || joining} onClick={() => handleJoin()}>
            {joining ? "Joining…" : "Join →"}
          </button>
        </div>
      )}

      {mode === "qr" && (
        <QRScanner onScan={handleJoin} onError={setError} />
      )}

      {error && <p className="pv-join-error">{error}</p>}

      <div className="pv-join-modes">
        <button className={`pv-mode-btn ${mode === "code" ? "active" : ""}`} onClick={() => { setMode("code"); setError(""); }}>Type code</button>
        <span className="pv-mode-dot">·</span>
        <button className={`pv-mode-btn ${mode === "link" ? "active" : ""}`} onClick={() => { setMode("link"); setError(""); }}>Paste link</button>
        <span className="pv-mode-dot">·</span>
        <button className={`pv-mode-btn ${mode === "qr"   ? "active" : ""}`} onClick={() => { setMode("qr"); setError(""); }}>Scan QR</button>
      </div>
    </div>
  );
}

function NewSessionModal({ onStart, onClose }) {
  const [title, setTitle]       = useState('');
  const [description, setDescription] = useState('');
  const [encrypted, setEncrypted] = useState(false);

  function handleStart() {
    onStart(title.trim(), description.trim(), encrypted);
  }

  return (
    <div className="pv-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="pv-modal pv-new-session-modal">
        <button className="pv-modal-close" onClick={onClose}>×</button>
        <h2>Start a session</h2>
        <p className="pv-modal-hint">Give your session a topic so participants know what it's about. Both fields are optional.</p>
        <label className="pv-field-label">Topic / title</label>
        <input
          className="pv-field-input"
          placeholder="e.g. Town Hall Q&A, Team Retrospective…"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={120}
          autoFocus
        />
        <label className="pv-field-label">Description <span className="pv-field-optional">(optional)</span></label>
        <textarea
          className="pv-field-input pv-field-textarea"
          placeholder="A sentence or two about the session…"
          value={description}
          onChange={e => setDescription(e.target.value)}
          maxLength={500}
          rows={3}
        />
        <label className="pv-field-label">
          <input
            type="checkbox"
            checked={encrypted}
            onChange={e => setEncrypted(e.target.checked)}
          />{' '}
          End-to-end encrypted <span className="pv-field-optional">(server only sees ciphertext; clustering not available yet)</span>
        </label>
        <button className="pv-btn-create pv-btn-create--modal" onClick={handleStart}>
          Create session →
        </button>
      </div>
    </div>
  );
}

export default function Home({ onNavigate, user, onOpenSidebar, onOpenAuth, onSignOut,
  bgKey, darkMode, onToggleDark, onSelectBg }) {
  const [showInstructions, setShowInstructions] = useState(false);
  const [showBgPicker,     setShowBgPicker]     = useState(false);
  const [showNewSession,   setShowNewSession]    = useState(false);

  return (
    <div className="pv-root">

      {/* ── Navbar ── */}
      <nav className="pv-nav">
        <button className="pv-nav-hamburger" onClick={onOpenSidebar} title="Session history">
          <span /><span /><span />
        </button>
        <div className="pv-nav-actions">
          <button className="pv-nav-btn" onClick={() => setShowInstructions(true)}>How it works</button>
          <button className="pv-nav-icon-btn" onClick={onToggleDark} title={darkMode ? "Light mode" : "Dark mode"}>
            {darkMode ? <SunIcon /> : <MoonIcon />}
          </button>
          <button className="pv-nav-icon-btn" onClick={() => setShowBgPicker(true)} title="Background">
            <SettingsIcon />
          </button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <main className="pv-home">
        <div className="pv-center">

          {/* Wordmark */}
          <div className="pv-wordmark">
            <span className="pv-wordmark-icon">🗳</span>
            <span className="pv-wordmark-text">Popular <em>Vote</em></span>
          </div>

          {/* Headline */}
          <h1 className="pv-headline">Let the room<br /><em>speak.</em></h1>
          <p className="pv-tagline">Anonymous questions, collectively surfaced.</p>

          {/* Primary action */}
          <button className="pv-btn-create" onClick={() => setShowNewSession(true)}>
            Start a session
          </button>

          {/* Divider */}
          <div className="pv-or">
            <span className="pv-or-line" />
            <span className="pv-or-text">or join one</span>
            <span className="pv-or-line" />
          </div>

          {/* Join flow */}
          <JoinFlow onJoin={code => onNavigate?.("participant", code)} />

        </div>
      </main>

      {showInstructions && <InstructionsModal onClose={() => setShowInstructions(false)} />}
      {showNewSession   && (
        <NewSessionModal
          onClose={() => setShowNewSession(false)}
          onStart={(title, description, encrypted) => {
            setShowNewSession(false);
            onNavigate?.("host", "NEW", { title, description, encrypted });
          }}
        />
      )}
      {showBgPicker     && (
        <BackgroundPicker current={bgKey} onSelect={onSelectBg}
          onClose={() => setShowBgPicker(false)} darkMode={darkMode} />
      )}
    </div>
  );
}
