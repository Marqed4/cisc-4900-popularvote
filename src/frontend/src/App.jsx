import { useState, useEffect } from 'react';
import { flushSync } from 'react-dom';
import Home from './components/home/Home.jsx';
import HostView from './components/host/Host.jsx';
import Participant from './components/participant/Participant.jsx';
import Sidebar from './components/account/Sidebar.jsx';
import AuthModal from './components/account/AuthModal.jsx';
import { DefaultBackgrounds } from './assets/backgrounds/index.js';
import { supabase } from './lib/supabase.js';
import './App.css';
// shared styles (background picker modal, nav icon buttons) live here and are used by Host/Participant too
import './components/home/Home.css';
import "./components/theme/foil-theme.css";

const BG_STORAGE_KEY = "pv-background";
const CLEAR_ON_EXIT_KEY = "pv-clear-on-exit";

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

// The root of the app and its whole router. there's no react-router, just one piece of state:
// view. null means Home, {role: "host"} mounts Host.jsx, {role: "participant"} mounts
// Participant.jsx. Home calls handleNavigate to pick one, and each screen's onBack sets view
// back to null. everything else in here (theme, sign-in, sidebar) wraps around that.
export default function App() {
  // which screen is showing: null (Home) or { role, code, ...meta }
  const [view, setView]         = useState(null);
  const [user, setUser]         = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showAuth, setShowAuth]       = useState(false);

  // Global theme + background, available across all pages
  const [bgKey,    setBgKey]    = useState(() => localStorage.getItem(BG_STORAGE_KEY) ?? "day_Sandstone");
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("pv-dark") === "true");

  // visual look: "foil" (default) or "playful". CSS keys off data-look on <html>, see foil-theme.css section 12
  const [look, setLook] = useState(() => localStorage.getItem("pv-look") === "playful" ? "playful" : "foil");
  useEffect(() => {
    document.documentElement.setAttribute("data-look", look);
    localStorage.setItem("pv-look", look);
  }, [look]);

  // Foil <-> Playful, with a show. the page is snapshotted, the look flips underneath, and the
  // new look is revealed through a circle that grows out of `origin` (the card that was clicked)
  // while a thin ring in the new accent colour rides the edge. View Transitions API: where the
  // browser lacks it, or the person asked for reduced motion, the look just changes.
  // the attribute is set by hand inside the callback because the transition takes its "after"
  // snapshot as soon as the callback returns, and a React effect would land a frame late.
  function changeLook(next, origin) {
    if (next === look) return;
    const root = document.documentElement;
    const apply = () => { root.setAttribute("data-look", next); setLook(next); };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!document.startViewTransition || reduce) { apply(); return; }

    const x = origin?.x ?? window.innerWidth / 2;
    const y = origin?.y ?? window.innerHeight / 2;
    // far enough to cover the whole viewport from wherever the circle starts
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const duration = 750;
    const easing = "cubic-bezier(0.65, 0, 0.35, 1)";

    const transition = document.startViewTransition(() => { flushSync(apply); });
    transition.ready.then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration, easing, pseudoElement: "::view-transition-new(root)" },
      );

      const ring = document.createElement("div");
      ring.className = "pv-look-ring";
      ring.style.cssText = `left:${x - radius}px;top:${y - radius}px;width:${radius * 2}px;height:${radius * 2}px;`;
      document.body.appendChild(ring);
      const grow = ring.animate(
        [{ transform: "scale(0)", opacity: 0.9 }, { transform: "scale(1)", opacity: 0 }],
        { duration, easing },
      );
      grow.onfinish = grow.oncancel = () => ring.remove();
    }).catch(() => {});
  }

  const [clearOnExit, setClearOnExit] = useState(() => localStorage.getItem(CLEAR_ON_EXIT_KEY) === "true");

  // Clean up removed feature keys so old localStorage values don't linger
  useEffect(() => { localStorage.removeItem("pv-glass"); localStorage.removeItem("pv-sound"); }, []);

  // opt-in: when the page goes away, take everything this site saved with it. history, theme,
  // room keys, the sign-in... all of it. pagehide fires on refresh too, the browser can't
  // tell leaving from staying, so a refresh clears it as well. only the setting survives.
  useEffect(() => {
    localStorage.setItem(CLEAR_ON_EXIT_KEY, String(clearOnExit));
    if (!clearOnExit) return;
    function flush() {
      try {
        localStorage.clear();
        localStorage.setItem(CLEAR_ON_EXIT_KEY, "true");
      } catch {
        // storage is blocked (private mode, usually), so there's nothing here to clear
      }
    }
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [clearOnExit]);

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

  const bgSrc = DefaultBackgrounds[bgKey] ?? DefaultBackgrounds.day_Sandstone;

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

  // sign-in plumbing. restore whoever was signed in, then listen for changes. a fresh sign-in
  // closes the modal and moves any anonymous history (localStorage) over to the account.
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

  // the one door into a session. Home calls this after creating (host) or joining (participant)
  // a room, and the Sidebar calls it when you reopen one from history. remember the room first,
  // then flip view, which is what actually swaps the screen. "NEW" is a host room that doesn't
  // have a code yet, so there's nothing to remember.
  function handleNavigate(role, code, meta = {}) {
    if (code && code !== "NEW") saveSession(code, role);
    setView({ role, code, ...meta });
  }

  // props every screen gets, so the theme survives moving between them
  const themeProps = {
    bgKey, darkMode,
    onToggleDark: handleToggleDark,
    look,
    onSelectLook: changeLook,
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
      clearOnExit={clearOnExit}
      onToggleClearOnExit={() => setClearOnExit(v => !v)}
    />
  );

  // the render ladder: host screen, participant screen, otherwise Home. each one carries the
  // same sidebar and sign-in modal alongside it.
  if (view?.role === "host") {
    return (
      <>
        <HostView
          code={view.code}
          initialTitle={view.title ?? ''}
          initialDescription={view.description ?? ''}
          initialEncrypted={view.encrypted ?? false}
          initialHashedIdentity={view.hashedIdentity ?? false}
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

  // joined a room. Participant takes it from here: it loads the session and opens its own socket.
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

  // no view means nobody is in a room yet, so this is the landing page
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
