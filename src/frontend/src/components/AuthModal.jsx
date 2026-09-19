import { useState } from "react";
import { supabase } from "../lib/supabase.js";
import "./Sidebar.css"; // reuses .am-* classes defined there

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

export default function AuthModal({ onClose }) {
  const [email,   setEmail]   = useState("");
  const [sent,    setSent]    = useState(false);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState("");

async function handleGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { 
      // redirectTo: "https://popularvote-production.up.railway.app",
      redirectTo: import.meta.env.VITE_SITE_URL ?? window.location.origin,
      skipBrowserRedirect: false
    },
  });
  if (error) setError(error.message);
}

  async function handleMagicLink() {
    if (!email.includes("@")) return;
    setLoading(true);
    setError("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) { setError(error.message); setLoading(false); return; }
    setSent(true);
    setLoading(false);
  }

  return (
    <div className="am-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="am-modal">
        <button className="am-close" onClick={onClose}>×</button>
        <h2 className="am-title">Save your sessions</h2>
        <p className="am-sub">Sign in to keep your history across devices.</p>

        {sent ? (
          <div className="am-sent">
            <div className="am-sent-icon">✉</div>
            <p>Check <strong>{email}</strong> for a sign-in link.</p>
            <button className="am-back" onClick={() => setSent(false)}>Use a different email</button>
          </div>
        ) : (
          <>
            <button className="am-google-btn" onClick={handleGoogle}>
              <GoogleIcon />
              Continue with Google
            </button>

            <div className="am-or"><span>or</span></div>

            <input
              className="am-email-input"
              type="email"
              placeholder="your@email.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleMagicLink()}
              autoFocus
            />
            {error && <div className="am-error">{error}</div>}
            <button
              className="am-magic-btn"
              onClick={handleMagicLink}
              disabled={!email.includes("@") || loading}
            >
              {loading ? "Sending…" : "Email me a sign-in link"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
