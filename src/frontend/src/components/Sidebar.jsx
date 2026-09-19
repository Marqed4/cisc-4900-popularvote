import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase.js";
import "./Sidebar.css";

const MY_SESSIONS_KEY = "pv-my-sessions";
const JOINED_KEY      = "pv-joined-sessions";

const PHASE_MAP = {
  OPEN:       ["sb-phase-open",    "Open"],
  CLOSED:     ["sb-phase-closed",  "Closed"],
  CLUSTERING: ["sb-phase-cluster", "Clustering"],
  RESULTS:    ["sb-phase-results", "Results"],
  ENDED:      ["sb-phase-ended",   "Ended"],
};

function PhaseBadge({ phase }) {
  const [cls, label] = PHASE_MAP[phase] ?? ["sb-phase-ended", phase];
  return <span className={`sb-phase ${cls}`}>{label}</span>;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function Sidebar({ open, onClose, user, onSignIn, onSignOut, onNavigate }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(false);

  useEffect(() => {
    if (open) loadSessions();
  }, [open, user]);

  async function loadSessions() {
    setLoading(true);
    try {
      if (user) {
        // load from Supabase user_sessions table
        const { data: userSessions, error } = await supabase
          .from("user_sessions")
          .select("session_code, role, saved_at")
          .eq("user_id", user.id)
          .eq("dismissed", false)
          .order("saved_at", { ascending: false });

        console.log('user id:', user.id);
        console.log('userSessions:', userSessions);
        console.log('error:', error);

        if (!userSessions?.length) { setSessions([]); setLoading(false); return; }

        const codes = userSessions.map(u => u.session_code);
        const { data: sessionData } = await supabase
          .from("sessions")
          // Display title not join code
          .select("code, phase, tags, title, created_at")
          .in("code", codes);

        const byCode = Object.fromEntries((sessionData ?? []).map(s => [s.code, s]));
        setSessions(
          userSessions
            .map(u => ({ ...byCode[u.session_code], code: u.session_code, role: u.role }))
            .filter(s => s.phase)
        );
      } else {
        // load from localStorage
        const created = JSON.parse(localStorage.getItem(MY_SESSIONS_KEY) ?? "[]");
        const joined  = JSON.parse(localStorage.getItem(JOINED_KEY) ?? "[]").map(s => s.code ?? s);
        const allCodes = [...new Set([...created, ...joined])];
        if (!allCodes.length) { setSessions([]); return; }

        const { data } = await supabase
          .from("sessions")
          // Display title not join code
          .select("code, phase, tags, title, created_at")
          .in("code", allCodes)
          .order("created_at", { ascending: false });

        setSessions((data ?? []).map(s => ({
          ...s,
          role: created.includes(s.code) ? "host" : "participant",
        })));
      }
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }

  async function dismiss(code) {
    setSessions(prev => prev.filter(s => s.code !== code));

    if (user) {
      await supabase
        .from("user_sessions")
        .update({ dismissed: true })
        .eq("user_id", user.id)
        .eq("session_code", code);
    } else {
      const created = JSON.parse(localStorage.getItem(MY_SESSIONS_KEY) ?? "[]");
      const joined  = JSON.parse(localStorage.getItem(JOINED_KEY) ?? "[]");
      localStorage.setItem(MY_SESSIONS_KEY, JSON.stringify(created.filter(c => c !== code)));
      localStorage.setItem(JOINED_KEY, JSON.stringify(joined.filter(s => (s.code ?? s) !== code)));
    }
  }

  return (
    <>
      {open && <div className="sb-backdrop" onClick={onClose} />}

      <aside className={`sb-sidebar ${open ? "sb-sidebar--open" : ""}`}>
        <div className="sb-header">
          <span className="sb-title">History</span>
          <button className="sb-close-btn" onClick={onClose} title="Close">×</button>
        </div>

        <div className="sb-body">
          {loading ? (
            <>{[1, 2, 3].map(i => <div key={i} className="sb-skeleton" />)}</>
          ) : sessions.length === 0 ? (
            <p className="sb-empty">
              No sessions yet.<br />
              <span>Create or join one to get started.</span>
            </p>
          ) : (
            sessions.map(s => (
              <div
                key={s.code}
                className="sb-item"
                onClick={() => { onNavigate(s.role, s.code); onClose(); }}
              >
                <div className="sb-item-content">
                  <div className="sb-item-topic">
                    {s.title || (s.tags?.length ? s.tags.join(", ") : s.code)}
                  </div>
                  <div className="sb-item-meta">
                    <span className="sb-item-role">{s.role === "host" ? "Host" : "Participant"}</span>
                    <span className="sb-dot">·</span>
                    <span className="sb-item-date">{formatDate(s.created_at)}</span>
                    <PhaseBadge phase={s.phase} />
                  </div>
                </div>
                <button
                  className="sb-dismiss"
                  title="Remove from history"
                  onClick={e => { e.stopPropagation(); dismiss(s.code); }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>

        <div className="sb-footer">
          {user ? (
            <div className="sb-user-row">
              <div className="sb-user-info">
                <div className="sb-avatar">{user.email?.[0]?.toUpperCase()}</div>
                <span className="sb-user-email" title={user.email}>{user.email}</span>
              </div>
              <button className="sb-signout-btn" onClick={onSignOut}>Sign out</button>
            </div>
          ) : (
            <button className="sb-signin-btn" onClick={onSignIn}>
              Sign in to save sessions →
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
