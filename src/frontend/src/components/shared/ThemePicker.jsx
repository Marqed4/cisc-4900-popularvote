import { DefaultBackgrounds } from "../../assets/backgrounds/index.js";

// The appearance picker behind the gear icon: which look (Foil or Playful) and which
// background. It used to be three copies of a background-only picker, one each in Home,
// HostHeader and ParticipantHeader.
//
// Picking a look leaves the picker open on purpose, so the switch animation (App.jsx,
// changeLook) plays where you can watch it. Picking a background closes it, as before.
// `onSelectLook(next, { x, y })` gets the middle of the card you clicked, which is where
// the reveal circle grows from.
const LOOKS = [
  { id: "foil", name: "Foil", blurb: "Metallic, editorial, condensed type." },
  { id: "playful", name: "Playful", blurb: "Rounded type, violet accent, a little bounce." },
];

export default function ThemePicker({ look, onSelectLook, bgKey, onSelectBg, darkMode, onClose }) {
  const backgrounds = Object.entries(DefaultBackgrounds).filter(([key]) =>
    darkMode ? key.startsWith("night_") : key.startsWith("day_")
  );

  function pickLook(next, e) {
    if (next === look) return;
    const r = e.currentTarget.getBoundingClientRect();
    onSelectLook?.(next, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }

  return (
    <div className="pv-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="pv-modal pv-bg-picker">
        <button className="pv-modal-close" onClick={onClose}>×</button>
        <h2>Appearance</h2>

        <div className="pv-look-group" role="radiogroup" aria-label="Look">
          {LOOKS.map(l => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={look === l.id}
              className={`pv-look-card pv-look-card--${l.id} ${look === l.id ? "pv-look-card--on" : ""}`}
              onClick={e => pickLook(l.id, e)}
            >
              <span className="pv-look-swatch" aria-hidden="true" />
              <span className="pv-look-name">{l.name}</span>
              <span className="pv-look-blurb">{l.blurb}</span>
            </button>
          ))}
        </div>

        <h3 className="pv-picker-subhead">Background</h3>
        <div className="pv-bg-grid">
          {backgrounds.map(([key, src]) => (
            <button key={key} className={`pv-bg-option ${bgKey === key ? "active" : ""}`}
              onClick={() => { onSelectBg(key); onClose(); }}>
              <img src={src} alt={key} />
              <span>{key.replace(/^(day_|night_)/, "").replace(/([A-Z])/g, " $1").trim()}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
