import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { supabase } from "../lib/supabase.js";
import {
  generateKeyPair, exportPublicKey, importPublicKey, unwrapRoomKey, encryptText,
} from "../lib/crypto";

import ParticipantClusterList from "./ParticipantCluster";
import ParticipantHeader from "./ParticipantHeader";
import ParticipantInput from "./ParticipantInput";
import Summary from "./Summary";

import "./ParticipantLayout.css";

// localStorage key scoped to this session code so multiple sessions don't collide
function mySubsKey(code) { return `pv-my-subs-${code}`; }

function loadMySubmissions(code) {
  try { return JSON.parse(localStorage.getItem(mySubsKey(code)) ?? "[]"); }
  catch { return []; }
}

function saveMySubmissions(code, submissions) {
  localStorage.setItem(mySubsKey(code), JSON.stringify(submissions));
}

export default function Participant({ code, onBack, user, onOpenSidebar, darkMode, onToggleDark, bgKey, onSelectBg }) {
  const [phase, setPhase] = useState("OPEN");
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submissions, setSubmissions] = useState(() => loadMySubmissions(code));
  const [clusters, setClusters] = useState([]);
  const [answers, setAnswers] = useState({});
  const [upvotes, setUpvotes] = useState({});
  const [submissionCount, setSubmissionCount] = useState(0);
  const [followups, setFollowups] = useState({});
  const [expansionPrompts, setExpansionPrompts] = useState([]);
  const [error, setError] = useState("");
  const [submitLoading, setSubmitLoading] = useState(false);
  const [loading, setLoading] = useState(true);

  const socketRef = useRef(null);
  const socketIdRef = useRef(null);

  // E2E state. Memory only, so a refresh needs the host to send the room key again.
  const keyPairRef = useRef(null);
  const roomKeyRef = useRef(null);
  const encryptedRef = useRef(false);

  useEffect(() => {
    fetchSession();
  }, []);

  useEffect(() => {
    if (!code) return;

    const apiUrl = import.meta.env.VITE_API_URL ?? "";
    const socket = io(apiUrl || "http://localhost:2167");
    socketRef.current = socket;

    socket.on("connect", () => {
      socketIdRef.current = socket.id;
      socket.emit("join:room", { code, role: "participant" });
    });

    socket.on("session:sync", async ({ clusters: syncClusters, phase: syncPhase, encrypted: syncEncrypted }) => {
      // E2E: announce our public key so the host can send us the room key.
      if (syncEncrypted) {
        encryptedRef.current = true;
        try {
          if (!keyPairRef.current) keyPairRef.current = await generateKeyPair();
          if (!roomKeyRef.current) {
            socket.emit("pubkey_exchange", { publicKey: await exportPublicKey(keyPairRef.current.publicKey) });
          }
        } catch (err) {
          console.error("[e2e] key announce failed:", err);
        }
      }
      if (syncClusters?.length) {
        setClusters(syncClusters);
        setAnswers(prev => {
          const next = { ...prev };
          syncClusters.forEach(c => { if (c.answer) next[String(c.id)] = c.answer; });
          return next;
        });
      }
      if (syncPhase) setPhase(syncPhase);
    });

    socket.on("reconnect", () => {
      fetchSession();
    });

    // E2E: host sent the room key wrapped for us. Unwrap it with the host's public key.
    socket.on("room_key_distribute", async ({ encryptedRoomKey, publicKey }) => {
      try {
        roomKeyRef.current = await unwrapRoomKey(
          encryptedRoomKey, keyPairRef.current.privateKey, await importPublicKey(publicKey),
        );
        setError("");
      } catch (err) {
        console.error("[e2e] room key unwrap failed:", err);
      }
    });

    socket.on("submission:count", ({ count }) => setSubmissionCount(count));
    socket.on("session:closed",    () => setPhase("CLOSED"));
    socket.on("session:clustering",() => setPhase("CLUSTERING"));
    socket.on("session:results",   ({ clusters }) => {
      setClusters(clusters);
      setAnswers(prev => {
        const next = { ...prev };
        (clusters ?? []).forEach(c => { if (c.answer) next[String(c.id)] = c.answer; });
        return next;
      });
      setPhase("RESULTS");
    });
    socket.on("session:expanding", () => setPhase("EXPANDING"));
    socket.on("expansion:prompts", ({ prompts }) => setExpansionPrompts(prompts ?? []));
    socket.on("cluster:followups", ({ clusterId, suggestions }) =>
      setFollowups(prev => ({ ...prev, [clusterId]: suggestions }))
    );
    socket.on("session:ended",     () => setPhase("ENDED"));
    socket.on("cluster:deleted",   ({ clusterId }) =>
      setClusters(prev => prev.filter(c => c.id !== clusterId))
    );
    socket.on("cluster:answered", ({ clusterId, answer }) =>
      setAnswers(prev => ({ ...prev, [String(clusterId)]: answer }))
    );
    socket.on("cluster:upvote", ({ questionText, upvoteCount }) =>
      setClusters(prev => prev.map(c => ({
        ...c,
        questions: c.questions?.map(q =>
          q.text === questionText ? { ...q, upvoteCount } : q
        ),
      })))
    );
    socket.on("cluster:submission:added", ({ clusterId, question, submissionCount }) => {
      setClusters(prev => prev.map(c => {
        if (String(c.id) !== String(clusterId)) return c;
        return {
          ...c,
          submission_count: submissionCount,
          questions: [...(c.questions ?? []), question],
        };
      }));
    });

    return () => socket.disconnect();
  }, [code]);

  useEffect(() => {
    if (!code || code === "NEW") return;
    const interval = setInterval(fetchSession, 10000);
    return () => clearInterval(interval);
  }, [code]);

  const apiBase = import.meta.env.VITE_API_URL ?? "";

  async function fetchSession() {
    try {
      const res = await fetch(`${apiBase}/api/sessions/${code}`);
      if (!res.ok) throw new Error("Session not found");
      const data = await res.json();
      setPhase(data.phase ?? "OPEN");
      setTitle(data.title ?? '');
      setDescription(data.description ?? '');
      setClusters(data.clusters ?? []);
      setSubmissionCount(data.submissionCount ?? 0);
      const savedAnswers = {};
      (data.clusters ?? []).forEach(c => {
        if (c.answer) savedAnswers[c.id] = c.answer;
      });
      setAnswers(savedAnswers);

      if (user) {
        const { data: rows, error: sbError } = await supabase
          .from("user_submissions")
          .select("submission_id, content")
          .eq("user_id", user.id)
          .eq("session_code", code);
        if (sbError) {
          console.error("[user_submissions] select failed:", sbError);
        } else if (rows?.length) {
          const restored = rows.map(r => ({ id: r.submission_id, text: r.content }));
          setSubmissions(restored);
          saveMySubmissions(code, restored);
        }
      }
    } catch (err) {
      setError("Could not load session.");
    } finally {
      setLoading(false);
    }
  }

  async function submitQuestion(text) {
    setSubmitLoading(true);
    setError("");
    try {
      // Encrypted sessions: send ciphertext + nonce, never the plaintext.
      let payload = { content: text };
      if (encryptedRef.current) {
        if (!roomKeyRef.current) throw new Error("Waiting for the host to share the encryption key. Try again in a moment.");
        const { ciphertext, nonce } = await encryptText(roomKeyRef.current, text);
        payload = { content: ciphertext, nonce };
      }
      const res = await fetch(`${apiBase}/api/sessions/${code}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSubmissions(prev => {
        const next = [...prev, { id: data.id, text }];
        saveMySubmissions(code, next);
        return next;
      });
      // Don't copy plaintext into Supabase for encrypted sessions.
      if (user && !encryptedRef.current) {
        const { error: sbError } = await supabase.from("user_submissions").insert({
          user_id: user.id, session_code: code, submission_id: data.id, content: text,
        });
        if (sbError) console.error("[user_submissions] insert failed:", sbError);
      }
    } catch (err) {
      setError(err.message ?? "Failed to submit question.");
    } finally {
      setSubmitLoading(false);
    }
  }

  async function deleteSubmission(submissionId) {
    try {
      await fetch(`${apiBase}/api/sessions/${code}/submit/${submissionId}`, { method: "DELETE" });
      setSubmissions(prev => {
        const next = prev.filter(s => s.id !== submissionId);
        saveMySubmissions(code, next);
        return next;
      });
      if (user) {
        const { error: sbError } = await supabase
          .from("user_submissions")
          .delete()
          .eq("user_id", user.id)
          .eq("submission_id", submissionId);
        if (sbError) console.error("[user_submissions] delete failed:", sbError);
      }
    } catch {
      setError("Failed to delete submission.");
    }
  }

  async function submitToCluster(clusterId, text) {
    setError("");
    try {
      const res = await fetch(`${apiBase}/api/sessions/${code}/clusters/${clusterId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSubmissions(prev => {
        const next = [...prev, { id: data.id, text, clusterId }];
        saveMySubmissions(code, next);
        return next;
      });
      if (user) {
        const { error: sbError } = await supabase.from("user_submissions").insert({
          user_id: user.id, session_code: code, submission_id: data.id, content: text,
        });
        if (sbError) console.error("[user_submissions] insert failed:", sbError);
      }
    } catch (err) {
      setError(err.message ?? "Failed to submit to cluster.");
    }
  }

  async function upvoteQuestion(questionText) {
    const alreadyVoted = upvotes[questionText];
    setUpvotes(prev => ({ ...prev, [questionText]: !alreadyVoted }));
    try {
      await fetch(`${apiBase}/api/sessions/${code}/upvote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionText, undo: alreadyVoted }),
      });
    } catch {
      setUpvotes(prev => ({ ...prev, [questionText]: alreadyVoted }));
    }
  }

  const myTexts = new Set(submissions.map(s => s.text));
  const inClusterCount = submissions.filter(s =>
    clusters.some(c => c.questions?.some(q => {
      const qText = (q.text ?? '').replace(/^\d+\.\s*/, '').trim().toLowerCase();
      const sText = s.text.trim().toLowerCase();
      return qText === sText || qText.includes(sText) || sText.includes(qText);
    }))
  ).length;

  const headerProps = {
    phase,
    code,
    onBack,
    onOpenSidebar,
    darkMode,
    onToggleDark,
    bgKey,
    onSelectBg,
    submittedCount: submissions.length,
    inClusterCount,
  };

  if (loading) {
    return (
      <div className="pd-root">
        <ParticipantHeader {...headerProps} />
        <div className="pd-body">
          <div className="pd-waiting">
            <div className="pd-spinner" />
          </div>
        </div>
      </div>
    );
  }

  if (phase === "ENDED") {
    return (
      <div className="pd-root">
        <ParticipantHeader {...headerProps} />
        <div className="pd-body">
          <Summary
            clusters={clusters}
            answers={answers}
            tags={[]}
            submissionCount={submissionCount}
          />
        </div>
      </div>
    );
  }

  if (phase === "OPEN" || phase === "CLOSED") {
    return (
      <div className="pd-root">
        <ParticipantHeader {...headerProps} />
        {(title || description) && (
          <div className="pd-session-context">
            {title && <div className="pd-session-title">{title}</div>}
            {description && <div className="pd-session-description">{description}</div>}
          </div>
        )}
        <div className="pd-body">
          <ParticipantInput
            phase={phase}
            submissions={submissions}
            submittedCount={submissions.length}
            inClusterCount={inClusterCount}
            submitLoading={submitLoading}
            error={error}
            onSubmit={submitQuestion}
            onDelete={deleteSubmission}
          />
        </div>
      </div>
    );
  }

  if (phase === "CLUSTERING") {
    return (
      <div className="pd-root">
        <ParticipantHeader {...headerProps} />
        <div className="pd-body">
          <div className="pd-waiting">
            <div className="pd-spinner" />
            <div className="pd-waiting-title">Grouping questions…</div>
            <p className="pd-waiting-sub">The host is clustering submissions. Results will appear shortly.</p>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "RESULTS") {
    return (
      <div className="pd-root">
        <ParticipantHeader {...headerProps} />
        <div className="pd-body">
          {error && <div className="pd-error">{error}</div>}
          <ParticipantInput
            phase="OPEN"
            submissions={submissions}
            submittedCount={submissions.length}
            inClusterCount={inClusterCount}
            submitLoading={submitLoading}
            error={null}
            onSubmit={submitQuestion}
            onDelete={deleteSubmission}
          />
          <ParticipantClusterList
            phase={phase}
            clusters={clusters}
            answers={answers}
            myTexts={myTexts}
            upvotes={upvotes}
            followups={followups}
            onUpvote={upvoteQuestion}
            onSubmitToCluster={submitToCluster}
          />
        </div>
      </div>
    );
  }

  if (phase === "EXPANDING") {
    return (
      <div className="pd-root">
        <ParticipantHeader {...headerProps} />
        <div className="pd-body">
          <div className="pd-round2-banner">
            <div className="pd-round2-title">Round 2: Dig deeper</div>
            <p className="pd-round2-sub">The host has answered the first round. Now's your chance to ask follow-up questions.</p>
          </div>

          {expansionPrompts.length > 0 && (
            <div className="pd-prompts">
              <div className="pd-prompts-label">Need inspiration? Here are some areas to explore:</div>
              <ul className="pd-prompts-list">
                {expansionPrompts.flatMap(p => p.questions).map((q, i) => (
                  <li key={i} className="pd-prompt-item">{q}</li>
                ))}
              </ul>
            </div>
          )}

          <ParticipantInput
            phase="OPEN"
            submissions={submissions}
            submittedCount={submissions.length}
            inClusterCount={0}
            submitLoading={submitLoading}
            error={error}
            onSubmit={submitQuestion}
            onDelete={deleteSubmission}
          />
        </div>
      </div>
    );
  }

  // Fallback - should never reach here
  return (
    <div className="pd-root">
      <ParticipantHeader {...headerProps} />
      <div className="pd-body">
        <div className="pd-waiting">
          <div className="pd-spinner" />
          <p className="pd-waiting-sub">Loading session…</p>
        </div>
      </div>
    </div>
  );
}
