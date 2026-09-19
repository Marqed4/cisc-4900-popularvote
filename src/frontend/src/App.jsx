import { useState, useEffect } from 'react';
import Home from './components/Home.jsx';
import HostView from './components/Host.jsx';
import Participant from './components/Participant.jsx';
import Sidebar from './components/Sidebar.jsx';
import AuthModal from './components/AuthModal.jsx';
import { DefaultBackgrounds } from './assets/backgrounds/index.js';
import { supabase } from './lib/supabase.js';
import './App.css';

const BG_STORAGE_KEY = "pv-background";

const MY_SESSIONS_KEY = "pv-my-sessions";
const JOINED_KEY      = "pv-joined-sessions";

// After sign-in, move any localStorage sessions into Supabase so history is preserved
async function migrateLocalSessions(userId) {
  try {
    const created = JSON.parse(localStorage.getItem(MY_SESSIONS_KEY) ?? "[]");
    const joined  = JSON.parse(localStorage.getItem(JOINED_KEY) ?? "[]").map(s => s.code ?? s);

    const rows = [
      ...created.map(code => ({ user_id: userId, session_code: code, role: "host" })),
      ...joined.filter(c => !created.includes(c)).map(code => ({ user_id: userId, session_code: code, role: "participant" })),
    ].filter(r => r.session_code);

    if (rows.length) {
      await supabase
        .from("user_sessions")
        .upsert(rows, { onConflict: "user_id,session_code", ignoreDuplicates: true });
      localStorage.removeItem(MY_SESSIONS_KEY);
      localStorage.removeItem(JOINED_KEY);
    }

    // migrate any locally-stored "my questions" for each session
    const allCodes = [...new Set([...created, ...joined])];
    for (const code of allCodes) {
      const key = `pv-my-subs-${code}`;
      try {
        const subs = JSON.parse(localStorage.getItem(key) ?? "[]");
        if (!subs.length) continue;
        const subRows = subs
          .map(s => ({ user_id: userId, session_code: code, submission_id: s.id, content: s.text ?? s.content ?? "" }))
          .filter(r => r.submission_id && r.content);
        if (subRows.length) {
          await supabase
            .from("user_submissions")
            .upsert(subRows, { onConflict: "user_id,submission_id", ignoreDuplicates: true });
          localStorage.removeItem(key);
        }
      } catch {}
    }
  } catch (err) {
    console.error('[migrateLocalSessions]', err);
  }
}

export default function App() {
  const [view, setView]         = useState(null);
  const [user, setUser]         = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showAuth, setShowAuth]       = useState(false);

  // Global theme + background, available across all pages
  const [bgKey,    setBgKey]    = useState(() => localStorage.getItem(BG_STORAGE_KEY) ?? "day_SummerForest");
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("pv-dark") === "true");

  // Clean up removed feature keys so old localStorage values don't linger
  useEffect(() => { localStorage.removeItem("pv-glass"); localStorage.removeItem("pv-sound"); }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
    localStorage.setItem("pv-dark", String(darkMode));
  }, [darkMode]);

  function handleToggleDark() {
    const next = !darkMode;
    const prefix = next ? "night_" : "day_";
    const match = Object.keys(DefaultBackgrounds).find(k => k.startsWith(prefix));
    if (match) { setBgKey(match); localStorage.setItem(BG_STORAGE_KEY, match); }
    setDarkMode(next);
  }

  function handleSelectBg(key) { setBgKey(key); localStorage.setItem(BG_STORAGE_KEY, key); }

  const bgSrc = DefaultBackgrounds[bgKey] ?? DefaultBackgrounds.day_SummerForest;

  // Apply background directly to <html>, most reliable across mobile browsers.
  // position:fixed divs break on iOS Safari during scroll.
  useEffect(() => {
    const el = document.documentElement;
    el.style.backgroundImage = `url(${bgSrc})`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundAttachment = "scroll";
  }, [bgSrc]);

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  useEffect(() => {
    // restore session on page load
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      const u = session?.user ?? null;
      setUser(u);
      if (u && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) {
        setShowAuth(false);
        await migrateLocalSessions(u.id);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Save a session reference: localStorage for anon users, Supabase for signed-in users
  async function saveSession(code, role) {
    if (!code || code === "NEW") return;

    if (user) {
      const { error } = await supabase
        .from("user_sessions")
        .upsert(
          { user_id: user.id, session_code: code, role },
          { onConflict: "user_id,session_code", ignoreDuplicates: true }
        );

      if (error) {
        console.error("[saveSession]", error);
      }
    } else {
      if (role === "host") {
        const prev = JSON.parse(localStorage.getItem(MY_SESSIONS_KEY) ?? "[]");
        if (!prev.includes(code)) {
          localStorage.setItem(MY_SESSIONS_KEY, JSON.stringify([code, ...prev]));
        }
      } else {
        const prev = JSON.parse(localStorage.getItem(JOINED_KEY) ?? "[]");
        const filtered = prev.filter(s => (s.code ?? s) !== code);
        localStorage.setItem(
          JOINED_KEY,
          JSON.stringify([{ code, joinedAt: new Date().toISOString() }, ...filtered])
        );
      }
    }

  }

  function handleNavigate(role, code, meta = {}) {
    if (code && code !== "NEW") saveSession(code, role);
    setView({ role, code, ...meta });
  }

  const themeProps = {
    bgKey, darkMode,
    onToggleDark: handleToggleDark,
    onSelectBg: handleSelectBg,
  };

  const sidebar = (
    <Sidebar
      open={sidebarOpen}
      onClose={() => setSidebarOpen(false)}
      user={user}
      onSignIn={() => { setSidebarOpen(false); setShowAuth(true); }}
      onSignOut={handleSignOut}
      onNavigate={(role, code) => { setSidebarOpen(false); handleNavigate(role, code); }}
    />
  );

  if (view?.role === "host") {
    return (
      <>
        <HostView
          code={view.code}
          initialTitle={view.title ?? ''}
          initialDescription={view.description ?? ''}
          user={user}
          onSessionCreated={code => saveSession(code, "host")}
          onBack={() => setView(null)}
          onOpenSidebar={() => setSidebarOpen(true)}
          {...themeProps}
        />
        {sidebar}
        {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      </>
    );
  }

  if (view?.role === "participant") {
    return (
      <>
        <Participant
          code={view.code}
          user={user}
          onBack={() => setView(null)}
          onOpenSidebar={() => setSidebarOpen(true)}
          {...themeProps}
        />
        {sidebar}
        {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      </>
    );
  }

  return (
    <>
      <Home
        onNavigate={handleNavigate}
        user={user}
        onOpenSidebar={() => setSidebarOpen(true)}
        onOpenAuth={() => setShowAuth(true)}
        onSignOut={handleSignOut}
        {...themeProps}
      />
      {sidebar}
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    </>
  );
}
