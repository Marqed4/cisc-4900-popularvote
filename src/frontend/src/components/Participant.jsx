import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { supabase } from "../lib/supabase.js";
import { getDeviceId } from "../lib/deviceId.js";
import {
  generateKeyPair, exportPublicKey, importPublicKey, unwrapRoomKey, encryptText, decryptText,
  saveRoomKey, loadRoomKey,
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

// Shared by Host.jsx's own copy: cluster representative_query/question text round-trip
// as ciphertext+nonce JSON blobs for encrypted sessions, same convention as submissions.
async function decryptClusters(clusters, encrypted, roomKey) {
  if (!encrypted) return clusters ?? [];
  const decryptField = async value => {
    try {
      const { ciphertext, nonce } = JSON.parse(value);
      return await decryptText(roomKey, ciphertext, nonce);
    } catch {
      return "[encrypted: key unavailable]";
    }
  };
  return Promise.all((clusters ?? []).map(async c => ({
    ...c,
    representative_query: await decryptField(c.representative_query),
    questions: await Promise.all((c.questions ?? []).map(async q => ({ ...q, text: await decryptField(q.text) }))),
  })));
}

// The participant's side of a session, start to finish. App.jsx mounts this once Home has
// joined the room, then it reads roughly like this:
//   1. load the saved room key, then fetch the session over REST (first paint)
//   2. open a socket, say hello, and let the server sync us (phase, clusters, curators)
//   3. if the room is encrypted, trade public keys with the host to get the room key
//   4. submit questions, upvote, follow up, all through REST while sockets push changes back
//   5. the host moves the phase along and the render ladder at the bottom picks a screen
// REST is the source of truth and the socket is the gossip. a 10 second poll covers the gaps.
export default function Participant({ code, onBack, user, onOpenSidebar, darkMode, onToggleDark, bgKey, onSelectBg }) {
  // phase mirrors the server: OPEN, CLOSED, CLUSTERING, RESULTS, EXPANDING, ENDED
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
  // Curators are tracked by socket id, so this is recomputed whenever the list changes.
  const [isCurator, setIsCurator] = useState(false);

  const socketRef = useRef(null);
  const socketIdRef = useRef(null);

  // E2E state. the room key is saved per session code, so a refresh doesn't mean waiting
  // around for the host to come back online and hand it over again.
  const keyPairRef = useRef(null);
  const roomKeyRef = useRef(null);
  const encryptedRef = useRef(false);

  // Step 1, first load. the saved key has to be in the ref before fetchSession runs, otherwise
  // an encrypted room paints as "key unavailable" for no good reason.
  useEffect(() => {
    if (!code) { setLoading(false); setError("No session code."); return; }
    (async () => {
      roomKeyRef.current = await loadRoomKey(code);
      fetchSession();
    })();
  }, [code]);

  // Step 2, the socket. one connection per room code, closed again when we leave.
  useEffect(() => {
    if (!code) return;

    const apiUrl = import.meta.env.VITE_API_URL ?? "";
    const socket = io(apiUrl || "http://localhost:2167");
    socketRef.current = socket;

    // connected: remember our socket id (curator status is keyed on it) and ask to join the room.
    // the server answers with session:sync.
    socket.on("connect", () => {
      socketIdRef.current = socket.id;
      socket.emit("join:room", { code, role: "participant", deviceId: getDeviceId() });
    });

    // the server's reply to join:room. catches us up on phase, clusters and curators, and for
    // encrypted rooms this is where step 3 starts: no room key yet means we announce our public key.
    socket.on("session:sync", async ({ clusters: syncClusters, phase: syncPhase, encrypted: syncEncrypted, curators: syncCurators }) => {
      setIsCurator((syncCurators ?? []).includes(socket.id));
      // E2E: send our public key so the host can hand us the room key.
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
        const decrypted = await decryptClusters(syncClusters, syncEncrypted, roomKeyRef.current);
        setClusters(decrypted);
        setAnswers(prev => {
          const next = { ...prev };
          decrypted.forEach(c => { if (c.answer) next[String(c.id)] = c.answer; });
          return next;
        });
      }
      if (syncPhase) setPhase(syncPhase);
    });

    // dropped and came back. we may have missed events while gone, so refetch everything.
    socket.on("reconnect", () => {
      fetchSession();
    });

    // E2E, step 3 finishing: the host sent the room key wrapped for us, so unwrap it with their public key.
    socket.on("room_key_distribute", async ({ encryptedRoomKey, publicKey }) => {
      try {
        roomKeyRef.current = await unwrapRoomKey(
          encryptedRoomKey, keyPairRef.current.privateKey, await importPublicKey(publicKey),
        );
        await saveRoomKey(code, roomKeyRef.current);
        setError("");
        // Anything rendered before the key arrived shows "key unavailable", so reload it.
        fetchSession();
      } catch (err) {
        console.error("[e2e] room key unwrap failed:", err);
      }
    });

    // Step 5, the host drives the phase and we just follow along. these events arrive in
    // roughly this order: closed, clustering, results, expanding, ended. sometimes it loops back.
    socket.on("submission:count", ({ count }) => setSubmissionCount(count));
    socket.on("session:closed",    () => setPhase("CLOSED"));
    socket.on("session:clustering",() => setPhase("CLUSTERING"));
    // clustering finished. the clusters ride along in the event, decrypted here if the room is
    // encrypted, and any answers the host already wrote get folded into the answers map.
    socket.on("session:results",   async ({ clusters }) => {
      const decrypted = await decryptClusters(clusters, encryptedRef.current, roomKeyRef.current);
      setClusters(decrypted);
      setAnswers(prev => {
        const next = { ...prev };
        decrypted.forEach(c => { if (c.answer) next[String(c.id)] = c.answer; });
        return next;
      });
      setPhase("RESULTS");
    });
    // round 2 begins. the prompts are optional inspiration shown above the input.
    socket.on("session:expanding", () => setPhase("EXPANDING"));
    socket.on("expansion:prompts", ({ prompts }) => setExpansionPrompts(prompts ?? []));
    // suggested follow-up questions for a cluster, generated after the host answers it
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
    socket.on("curator:promoted", ({ curators }) =>
      setIsCurator((curators ?? []).includes(socket.id))
    );
    // someone upvoted. matched by question text, the only handle the server has, so everyone's
    // counts move together.
    socket.on("cluster:upvote", ({ questionText, upvoteCount }) =>
      setClusters(prev => prev.map(c => ({
        ...c,
        questions: c.questions?.map(q =>
          q.text === questionText ? { ...q, upvoteCount } : q
        ),
      })))
    );
    // a follow-up question landed in an existing cluster (ours or someone else's). decrypt it if
    // needed and append it, no refetch required.
    socket.on("cluster:submission:added", async ({ clusterId, question, submissionCount }) => {
      let decryptedQuestion = question;
      if (encryptedRef.current) {
        try {
          const { ciphertext, nonce } = JSON.parse(question.text);
          decryptedQuestion = { ...question, text: await decryptText(roomKeyRef.current, ciphertext, nonce) };
        } catch {
          decryptedQuestion = { ...question, text: "[encrypted: key unavailable]" };
        }
      }
      setClusters(prev => prev.map(c => {
        if (String(c.id) !== String(clusterId)) return c;
        return {
          ...c,
          submission_count: submissionCount,
          questions: [...(c.questions ?? []), decryptedQuestion],
        };
      }));
    });

    return () => socket.disconnect();
  }, [code]);

  // safety net: refetch every 10 seconds in case a socket event got lost on the way here
  useEffect(() => {
    if (!code || code === "NEW") return;
    const interval = setInterval(fetchSession, 10000);
    return () => clearInterval(interval);
  }, [code]);

  const apiBase = import.meta.env.VITE_API_URL ?? "";

  // GET /api/sessions/:code. runs on mount, on reconnect, after the room key arrives, and on the
  // poll. replaces phase, clusters and answers wholesale, then (signed in only) restores "my
  // questions" from Supabase so they follow the account across devices. loading ends here.
  async function fetchSession() {
    try {
      const res = await fetch(`${apiBase}/api/sessions/${code}`);
      if (!res.ok) throw new Error("Session not found");
      const data = await res.json();
      setPhase(data.phase ?? "OPEN");
      setTitle(data.title ?? '');
      setDescription(data.description ?? '');
      encryptedRef.current = !!data.encrypted;
      if (socketIdRef.current) setIsCurator((data.curators ?? []).includes(socketIdRef.current));
      const decryptedClusters = await decryptClusters(data.clusters, data.encrypted, roomKeyRef.current);
      setClusters(decryptedClusters);
      setSubmissionCount(data.submissionCount ?? 0);
      const savedAnswers = {};
      decryptedClusters.forEach(c => {
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

  // Step 4, asking. triggered by ParticipantInput's submit button. encrypts if the room is
  // encrypted, POSTs to /submit, then remembers the question locally (and in Supabase for signed
  // in users). the server broadcasts submission:count, so nobody needs to be told here.
  async function submitQuestion(text) {
    setSubmitLoading(true);
    setError("");
    try {
      // Encrypted sessions send ciphertext plus nonce, never the plaintext.
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
      // Skip the Supabase copy for encrypted sessions so plaintext never lands there.
      if (user && !encryptedRef.current) {
        const { error: sbError } = await supabase.from("user_submissions").insert({
          user_id: user.id, session_code: code, submission_id: data.id, content: text,
        });
        if (sbError) console.error("[user_submissions] insert failed:", sbError);
      }
      return true;
    } catch (err) {
      setError(err.message ?? "Failed to submit question.");
      return false;
    } finally {
      setSubmitLoading(false);
    }
  }

  // the little x on one of your own questions. deletes on the server first, then clears it from
  // local storage and Supabase. the question was only ever yours to take back, I guess.
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

  // a follow-up aimed at one specific cluster, from ParticipantCluster. same shape as
  // submitQuestion but it hits the cluster's own endpoint, and the server then emits
  // cluster:submission:added so every screen (ours included) gets the new question.
  async function submitToCluster(clusterId, text) {
    setError("");
    try {
      let payload = { content: text };
      if (encryptedRef.current) {
        if (!roomKeyRef.current) throw new Error("Waiting for the host to share the encryption key. Try again in a moment.");
        const { ciphertext, nonce } = await encryptText(roomKeyRef.current, text);
        payload = { content: ciphertext, nonce };
      }
      const res = await fetch(`${apiBase}/api/sessions/${code}/clusters/${clusterId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSubmissions(prev => {
        const next = [...prev, { id: data.id, text, clusterId }];
        saveMySubmissions(code, next);
        return next;
      });
      // Skip the Supabase copy for encrypted sessions so plaintext never lands there (matches submitQuestion).
      if (user && !encryptedRef.current) {
        const { error: sbError } = await supabase.from("user_submissions").insert({
          user_id: user.id, session_code: code, submission_id: data.id, content: text,
        });
        if (sbError) console.error("[user_submissions] insert failed:", sbError);
      }
      return true;
    } catch (err) {
      setError(err.message ?? "Failed to submit to cluster.");
      return false;
    }
  }

  // curators answer through the same endpoint the host does. the server doesn't check who's
  // asking (issue #4), so for now the buttons are the only thing keeping people honest.
  async function saveClusterAnswer(clusterId, answer) {
    setError("");
    try {
      const res = await fetch(`${apiBase}/api/sessions/${code}/clusters/${clusterId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setAnswers(prev => ({ ...prev, [String(clusterId)]: answer }));
      return true;
    } catch (err) {
      setError(err.message ?? "Failed to save answer.");
      return false;
    }
  }

  // optimistic upvote toggle. flips the local state first so the button feels instant, tells the
  // server (undo when it was already voted), and flips back if the request never lands. the real
  // count comes back to everyone through cluster:upvote.
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

  // derived values for the screens below. myTexts marks which questions are ours, and
  // inClusterCount is how many of our questions the clustering actually placed (fuzzy text match,
  // since clustering may rewrite a question a little).
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

  // Everything below is the render ladder: first matching phase wins, top to bottom.
  // loading -> ENDED -> OPEN/CLOSED -> CLUSTERING -> RESULTS -> EXPANDING -> fallback.

  // nothing fetched yet, just a spinner
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

  // the host ended it. read-only summary of every cluster and answer, the last page of the book.
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

  // round 1. OPEN takes questions, CLOSED shows the same screen with input disabled (the
  // phase prop is what tells ParticipantInput which one it is) while the host decides what's next.
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

  // the host pressed cluster. nothing to do but wait for session:results.
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

  // clusters are out. we can still ask more (the input is forced to OPEN here), upvote questions,
  // add follow-ups to a cluster, and, if promoted, answer clusters as a curator.
  if (phase === "RESULTS") {
    return (
      <div className="pd-root">
        <ParticipantHeader {...headerProps} />
        <div className="pd-body">
          {error && <div className="pd-error">{error}</div>}
          {isCurator && (
            <div className="pd-round2-banner">
              <div className="pd-round2-title">You're a curator</div>
              <p className="pd-round2-sub">The host has asked you to help answer. Use "Answer this cluster" on any cluster below.</p>
            </div>
          )}
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
            isCurator={isCurator}
            onSaveAnswer={saveClusterAnswer}
          />
        </div>
      </div>
    );
  }

  // round 2. the host answered round 1 and asks for follow-ups. inClusterCount is 0 on purpose,
  // new questions here haven't been clustered yet.
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