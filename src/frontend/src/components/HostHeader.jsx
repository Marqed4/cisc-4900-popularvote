import { useState } from "react";
import { DefaultBackgrounds } from '../assets/backgrounds/index.js';
import "./HostHeader.css";

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

export default function HostHeader({ phase, participantCount, submissionCount, onBack, onOpenSidebar, darkMode, onToggleDark, bgKey, onSelectBg }) {
  const [showBgPicker, setShowBgPicker] = useState(false);

  return (
    <>
      <header className="hd-header">
        <div className="hd-header-left">
          <button className="hd-hamburger" onClick={onOpenSidebar} title="Session history">
            <span /><span /><span />
          </button>
          <button className="hd-back" onClick={onBack}>← back</button>
          <div className="hd-header-meta">
            <span className="hd-header-label">Host Dashboard</span>
            <span className={`hd-phase hd-phase--${phase.toLowerCase()}`}>{phase}</span>
          </div>
        </div>

        <div className="hd-header-right">
          <div className="hd-stat">
            <span className="hd-stat-num">{participantCount}</span>
            <span className="hd-stat-label">participants</span>
          </div>
          <div className="hd-stat">
            <span className="hd-stat-num">{submissionCount}</span>
            <span className="hd-stat-label">submissions</span>
          </div>
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