import { useState } from "react";
import { DefaultBackgrounds } from '../assets/backgrounds/index.js';
import "./ParticipantHeader.css";

// Icons

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

export default function ParticipantHeader({ phase = "OPEN", code, onBack, onOpenSidebar, submittedCount, inClusterCount, darkMode, onToggleDark, bgKey, onSelectBg }) {
  const [showBgPicker, setShowBgPicker] = useState(false);
  const showStats = phase === "RESULTS" || phase === "ENDED";

  return (
    <>
      <header className="pd-header">
        <div className="pd-header-left">
          <button className="pd-hamburger" onClick={onOpenSidebar} title="Session history">
            <span /><span /><span />
          </button>
          <button className="pd-back" onClick={onBack}>← back</button>
          <div className="pd-header-meta">
            <span className="pd-header-label">Participant</span>
            <span className={`pd-phase pd-phase--${phase.toLowerCase()}`}>{phase}</span>
          </div>
        </div>

        <div className="pd-header-right">
          <span className="pd-header-code">{code}</span>

          {showStats && (
            <div className="pd-header-stats">
              <div className="pd-hstat">
                <span className="pd-hstat-num">{submittedCount ?? 0}</span>
                <span className="pd-hstat-label">submitted</span>
              </div>
              <div className="pd-hstat">
                <span className="pd-hstat-num">{inClusterCount ?? 0}</span>
                <span className="pd-hstat-label">in cluster</span>
              </div>
            </div>
          )}

          <button className="pv-nav-icon-btn" onClick={onToggleDark} title={darkMode ? "Light mode" : "Dark mode"}>
            {darkMode ? <SunIcon /> : <MoonIcon />}
          </button>
          <button className="pv-nav-icon-btn" onClick={() => setShowBgPicker(true)} title="Background">
            <SettingsIcon />
          </button>
        </div>
      </header>

      {showBgPicker && (
        <BackgroundPicker
          current={bgKey}
          onSelect={onSelectBg}
          onClose={() => setShowBgPicker(false)}
          darkMode={darkMode}
        />
      )}
    </>
  );
}