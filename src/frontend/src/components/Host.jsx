import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";

import {
  generateKeyPair, exportPublicKey, importPublicKey, generateRoomKey,
  wrapRoomKey, encryptText, decryptText, saveRoomKey, loadRoomKey,
} from "../lib/crypto";
import { clusterQuestions } from "../lib/clustering";
import HostHeader from "./HostHeader";
import HostList from "./HostList";
import HostSidebar from "./HostSidebar.jsx";
import ParticipantList from "./ParticipantList";
import "./HostLayout.css";

// The host's side of a room, start to finish. rough order of events:
//   1. mount: code "NEW" creates a room (createSession), anything else loads an old one (fetchSession)
//   2. the socket joins the room as host and keeps state fresh, polling is the backup plan
//   3. phases only ever move one way, mostly: OPEN -> CLOSED -> CLUSTERING -> RESULTS,
//      then EXPANDING (second round) loops back to RESULTS, and ENDED is where it stops
//   4. on encrypted rooms this browser holds the room key, so all the reading and
//      clustering happens here and the server only ever passes ciphertext along
export default function HostDashboard({ code: initialCode, initialTitle = '', initialDescription = '', initialEncrypted = false, onBack, onSessionCreated, onOpenSidebar, darkMode, onToggleDark, bgKey, onSelectBg }) {
  // ====================== State ======================

  // Core session state. phase mirrors the server's phase, the server wins any argument.
  const [phase, setPhase] = useState("OPEN");
  const [code, setCode] = useState(initialCode);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [encrypted, setEncrypted] = useState(initialEncrypted);
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState("");
  const [participantCount, setParticipantCount] = useState(0);
  const [submissionCount, setSubmissionCount] = useState(0);
  const [submissionsAtLastCluster, setSubmissionsAtLastCluster] = useState(0);
  const [clusters, setClusters] = useState([]);
  const [submissions, setSubmissions] = useState([]);
  const [hostNotes, setHostNotes] = useState(null);
  const [suggestedAnswers, setSuggestedAnswers] = useState({});
  const [loading, setLoading] = useState(initialCode === "NEW");
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState({});
  const [editingAnswer, setEditingAnswer] = useState(null);

  // Expansion state
  const [expansionPreviews, setExpansionPreviews] = useState({});
  const [selectedQuestions, setSelectedQuestions] = useState({});
  const [manualQuestions, setManualQuestions] = useState({});
  const [expandLoading, setExpandLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Curator / participant state
  const [participants, setParticipants] = useState([]);
  const [curators, setCurators] = useState([]);

  // socketRef holds the live connection for the emit-only actions. createdRef stops
  // React's double-mount from making two rooms in dev, one is plenty.
  const socketRef  = useRef(null);
  const createdRef = useRef(false);

  // E2E state. the room key also lives in localStorage under the session code now, so a
  // refresh or a server restart doesn't leave old submissions unreadable (E2E-6).
  const codeRef = useRef(initialCode);
  const encryptedRef = useRef(initialEncrypted);
  const hostKeysRef = useRef(null); // promise of { keyPair, publicKey, roomKey }
  const apiBase = import.meta.env.VITE_API_URL ?? "";

  // ====================== E2E helpers ======================

  // the keypair is made fresh whenever it's first needed. the room key is the one worth
  // keeping: if this browser already saved one for the session we pick it back up, otherwise
  // we make a new one and hold onto it. losing it means losing every question, so... yeah.
  function ensureHostKeys() {
    if (!hostKeysRef.current) {
      hostKeysRef.current = (async () => {
        const keyPair = await generateKeyPair();
        let roomKey = await loadRoomKey(codeRef.current);
        if (!roomKey) {
          roomKey = await generateRoomKey();
          await saveRoomKey(codeRef.current, roomKey);
        }
        return {
          keyPair,
          publicKey: await exportPublicKey(keyPair.publicKey),
          roomKey,
        };
      })();
    }
    return hostKeysRef.current;
  }

  // Turns a stored submission ({ciphertext, nonce} JSON) back into readable text.
  // every incoming submission passes through here, plaintext rooms just get it back untouched.
  async function readSubmission(sub) {
    if (!encryptedRef.current) return sub;
    try {
      const { ciphertext, nonce } = JSON.parse(sub.content);
      const { roomKey } = await ensureHostKeys();
      return { ...sub, content: await decryptText(roomKey, ciphertext, nonce) };
    } catch {
      return { ...sub, content: "[encrypted: key unavailable]" };
    }
  }

  // Same idea, one string field at a time (cluster representative_query / question text).
  async function decryptField(value) {
    if (!encryptedRef.current) return value;
    try {
      const { ciphertext, nonce } = JSON.parse(value);
      const { roomKey } = await ensureHostKeys();
      return await decryptText(roomKey, ciphertext, nonce);
    } catch {
      return "[encrypted: key unavailable]";
    }
  }

  // the other direction: plain text in, a {ciphertext, nonce} JSON string out, ready to send.
  async function encryptField(value) {
    const { roomKey } = await ensureHostKeys();
    const { ciphertext, nonce } = await encryptText(roomKey, value);
    return JSON.stringify({ ciphertext, nonce });
  }

  // Clusters round-trip the same way submissions do: stored/sent as ciphertext blobs,
  // decrypted here only for display. Keeps the server blind to cluster content too.
  async function readCluster(cluster) {
    if (!encryptedRef.current) return cluster;
    return {
      ...cluster,
      representative_query: await decryptField(cluster.representative_query),
      questions: await Promise.all(
        (cluster.questions ?? []).map(async q => ({ ...q, text: await decryptField(q.text) }))
      ),
    };
  }

  // used only by triggerClustering on encrypted rooms: the clusters we built locally
  // get scrambled here before they're posted to the server.
  async function encryptCluster(cluster) {
    return {
      representativeQuery: await encryptField(cluster.representativeQuery),
      submissionCount: cluster.submissionCount,
      questions: await Promise.all(
        cluster.questions.map(async q => ({ ...q, text: await encryptField(q.text) }))
      ),
    };
  }

  // ====================== API & Session Management ======================
  // Defined BEFORE useEffects so closures can reference them safely.

  // Step one for a brand new room. fired once by the mount effect when code is "NEW".
  // posts the title/description/encrypted choice, takes the real code back, stashes the
  // room key under that code if encrypted, tells App the code (so the URL updates), and
  // remembers the code in localStorage so the sidebar can list it later. after this the
  // code state changes, which is what wakes up the socket effect below.
  async function createSession() {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags, title: initialTitle, description: initialDescription, encrypted: initialEncrypted }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      encryptedRef.current = !!data.encrypted;
      setEncrypted(!!data.encrypted);
      codeRef.current = data.code;
      setCode(data.code);
      if (data.encrypted) {
        const { roomKey } = await ensureHostKeys();
        await saveRoomKey(data.code, roomKey);
      }
      onSessionCreated?.(data.code);
      const mine = JSON.parse(localStorage.getItem("pv-my-sessions") ?? "[]");
      if (!mine.includes(data.code)) localStorage.setItem("pv-my-sessions", JSON.stringify([data.code, ...mine]));
      setPhase(data.phase);
      setTags(data.tags ?? []);
      setTitle(data.title ?? '');
      setDescription(data.description ?? '');
    } catch (err) {
      setError(err.message ?? "Failed to create session.");
    } finally {
      setLoading(false);
    }
  }

  // The catch-all refresh: pulls the whole room from the server and overwrites local state.
  // runs on mount for existing rooms, after a socket reconnect, and every 10s from the
  // polling effect. decrypts submissions and clusters on the way in, then rebuilds the
  // per-cluster answer / selected-question / preview maps from what the server saved.
  // takes the code as an argument because state may not have caught up yet.
  // (uses the `code` state, not `initialCode`, so polling after a NEW room hits the right endpoint)
  async function fetchSession(sessionCode = code) {
    try {
      const res = await fetch(`${apiBase}/api/sessions/${sessionCode}`);
      if (!res.ok) throw new Error("Session not found");

      const data = await res.json();

      setPhase(data.phase);
      setTags(data.tags ?? []);
      setTitle(data.title ?? '');
      setDescription(data.description ?? '');
      setHostNotes(data.hostNotes ?? null);
      encryptedRef.current = !!data.encrypted;
      setEncrypted(!!data.encrypted);
      setSubmissions(await Promise.all((data.submissions ?? []).map(readSubmission)));
      setSubmissionCount(data.submissionCount ?? 0);
      setSubmissionsAtLastCluster(data.submissionsAtLastCluster ?? 0);
      setParticipantCount(data.participantCount ?? 0);
      setClusters(await Promise.all((data.clusters ?? []).map(readCluster)));
      setCurators(data.curators ?? []);

      // answers are keyed by cluster id, and by "<id>::followup" for the participant's
      // follow-up answer, same convention saveAnswer splits apart again later.
      const savedAnswers = {};
      const savedSelected = {};
      const savedPreviews = {};

      (data.clusters ?? []).forEach(c => {
        if (c.answer) savedAnswers[c.id] = c.answer;
        if (c.participant_answers?.length) {
          savedAnswers[c.id + "::followup"] = c.participant_answers[c.participant_answers.length - 1];
        }
        if (c.selected_questions?.length) {
          savedSelected[c.id] = new Set(c.selected_questions);
        }
        if (c.previewed_questions?.length) {
          savedPreviews[c.id] = { questions: c.previewed_questions, loading: false };
        }
      });

      setAnswers(savedAnswers);
      setSelectedQuestions(savedSelected);
      setExpansionPreviews(savedPreviews);
    } catch (err) {
      setError("Could not load session.");
    }
  }

  // ====================== Effects ======================

  // On mount: a new room gets created, an existing one gets loaded. runs once.
  useEffect(() => {
    if (initialCode === "NEW") {
      if (createdRef.current) return;
      createdRef.current = true;
      createSession();
    } else {
      fetchSession(initialCode);
    }
  }, []);

  // Socket connection and real-time listeners. waits for a real code, joins the room as
  // host, then every server broadcast below nudges local state so the page follows the
  // session without asking. the cleanup disconnects when the code changes or we unmount.
  useEffect(() => {
    if (!code || code === "NEW") return;

    const socket = io(import.meta.env.VITE_API_URL ?? "http://localhost:2167");
    socketRef.current = socket;

    // -- joining and staying joined --
    socket.on("connect", () => {
      socket.emit("join:room", { code, role: "host" });
    });

    // anything could have happened while we were gone, so reload the whole room
    socket.on("reconnect", () => {
      fetchSession(code);
    });

    // -- submissions coming in (phase OPEN, and RESULTS/EXPANDING for late ones) --
    // count is just the number, new carries the content, which we decrypt before showing
    socket.on("submission:count", ({ count }) => setSubmissionCount(count));
    socket.on("submission:new", async ({ id, content }) => {
      const sub = await readSubmission({ id, content });
      setSubmissions(prev => [...prev, sub]);
    });

    // E2E: a joiner sent us their public key, so wrap the room key for them and send it back.
    socket.on("pubkey_exchange", async ({ socketId, publicKey }) => {
      if (!encryptedRef.current) return;
      try {
        const { keyPair, publicKey: hostPublicKey, roomKey } = await ensureHostKeys();
        const encryptedRoomKey = await wrapRoomKey(
          roomKey, keyPair.privateKey, await importPublicKey(publicKey),
        );
        socket.emit("room_key_distribute", {
          targetSocketId: socketId, encryptedRoomKey, publicKey: hostPublicKey,
        });
      } catch (err) {
        console.error("[e2e] key distribution failed:", err);
      }
    });

    // -- phase changes the server announces --
    // CLOSED: submissions stopped. CLUSTERING: the grouping is running somewhere.
    // RESULTS: clusters are ready, so we decrypt and show them. these also fire for
    // this host's own actions, which is fine, setting the same phase twice hurts nobody.
    socket.on("session:closed", () => setPhase("CLOSED"));
    socket.on("session:clustering", () => setPhase("CLUSTERING"));
    socket.on("session:results", async ({ clusters, submissionsAtLastCluster }) => {
      setClusters(await Promise.all((clusters ?? []).map(readCluster)));
      if (submissionsAtLastCluster !== undefined) setSubmissionsAtLastCluster(submissionsAtLastCluster);
      setPhase("RESULTS");
    });

    // -- cluster activity once results exist --
    // a participant upvoted a question, patch its count in place
    socket.on("cluster:upvote", ({ questionText, upvoteCount }) => {
      setClusters(prev =>
        prev.map(c => ({
          ...c,
          questions: c.questions?.map(q =>
            q.text === questionText ? { ...q, upvoteCount } : q
          ),
        }))
      );
    });

    // AI drafted answers from the host's notes, arrives right after results. they sit in
    // suggestedAnswers until the host clicks "use suggestion", nothing is saved on its own.
    socket.on("cluster:suggestions", ({ suggestions }) => {
      setSuggestedAnswers(prev => {
        const next = { ...prev };
        suggestions.forEach(({ clusterId, suggestion }) => {
          if (suggestion) next[clusterId] = suggestion;
        });
        return next;
      });
    });

    // ENDED is the last phase, the summary page takes over from here
    socket.on("session:ended", () => setPhase("ENDED"));
    socket.on("cluster:deleted", ({ clusterId }) =>
      setClusters(prev => prev.filter(c => c.id !== clusterId))
    );

    // answers saved by the host (cluster:answered) or a participant's follow-up
    // answer (cluster:followup:answered), same key scheme as fetchSession uses
    socket.on("cluster:answered", ({ clusterId, answer }) =>
      setAnswers(prev => ({ ...prev, [clusterId]: answer }))
    );

    socket.on("cluster:followup:answered", ({ clusterId, answer }) =>
      setAnswers(prev => ({ ...prev, [clusterId + "::followup"]: answer }))
    );

    // -- who's in the room --
    // the list is built from join/leave events, so someone who joined before the host
    // connected only shows up in the count... that's a known gap, I guess.
    socket.on("participant:joined", ({ socketId, count }) => {
      setParticipantCount(count);
      setParticipants(prev => {
        if (prev.find(p => p.socketId === socketId)) return prev;
        return [...prev, { socketId, isCurator: false }];
      });
    });

    socket.on("participant:left", ({ socketId, count }) => {
      setParticipantCount(count);
      setParticipants(prev => prev.filter(p => p.socketId !== socketId));
    });

    // a curator was promoted or demoted, update the badge on each participant
    socket.on("curator:promoted", ({ curators: newCurators }) => {
      setCurators(newCurators);
      setParticipants(prev =>
        prev.map(p => ({ ...p, isCurator: newCurators.includes(p.socketId) }))
      );
    });

    // -- second round (EXPANDING) --
    // the server sends follow-up question previews per cluster, we store them and drop
    // back to RESULTS so the host can pick which ones to ask the room
    socket.on("expansion:preview", ({ clusterPreviews }) => {
      console.log("[socket] expansion:preview received", { clusterPreviews });
      setExpansionPreviews(prev => {
        const next = { ...prev };
        clusterPreviews.forEach(({ clusterId, previewedQuestions }) => {
          next[clusterId] = { questions: previewedQuestions, loading: false };
        });
        console.log("[socket] expansion:preview new expansionPreviews:", next);
        return next;
      });
      console.log("[socket] setting phase to RESULTS");
      setPhase("RESULTS");
    });

    // a question was added straight into a cluster (see submitManualQuestion), so it
    // skips the submissions list and lands in the cluster's questions, decrypted first
    socket.on("cluster:submission:added", async ({ clusterId, question, submissionCount }) => {
      console.log("[cluster:submission:added]", { clusterId, question, submissionCount });
      const decryptedQuestion = { ...question, text: await decryptField(question.text) };
      setClusters(prev =>
        prev.map(c => {
          if (String(c.id) !== String(clusterId)) return c;
          return {
            ...c,
            submission_count: submissionCount,
            questions: [...(c.questions ?? []), decryptedQuestion],
          };
        })
      );
    });

    // deleteSession() below emits host:delete_session, the server confirms with this,
    // and we leave since there's no room left to look at
    socket.on("session:deleted", () => onBack());

    return () => socket.disconnect();
  }, [code]);

  // Polling fallback. sockets drop quietly sometimes, so every 10s we reload the whole room anyway.
  useEffect(() => {
    if (!code || code === "NEW") return;
    const interval = setInterval(() => fetchSession(code), 10000);
    return () => clearInterval(interval);
  }, [code]);

  // Theme setup
  useEffect(() => {
    const dark = localStorage.getItem("pv-dark") === "true";
    const glass = localStorage.getItem("pv-glass") === "true";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.documentElement.setAttribute("data-glass", glass ? "on" : "off");
  }, []);

  // ====================== Actions ======================
  // The host's buttons, in the order a session usually uses them:
  // close -> cluster -> answer -> (second round) -> end. each one calls the API and the
  // socket broadcast above carries the news to everyone else.

  // "Close submissions" button in the sidebar. OPEN -> CLOSED. the server also
  // broadcasts session:closed so participants stop being able to submit.
  async function closeSubmissions() {
    setActionLoading(true);
    setError("");
    try {
      const res = await fetch(`${apiBase}/api/sessions/${code}/close`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error);
      setPhase("CLOSED");
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  // "Cluster" button (also the re-cluster button from RESULTS). CLOSED -> CLUSTERING -> RESULTS.
  // two paths: encrypted rooms cluster here in the browser and post ciphertext, plain
  // rooms just ask the server to do it. any failure drops back to CLOSED so it can be retried.
  async function triggerClustering() {
    if (submissionCount === 0) {
      setError("No submissions yet.");
      return;
    }
    setActionLoading(true);
    setError("");
    setPhase("CLUSTERING");

    try {
      if (encrypted) {
        // The server never sees these questions in plaintext, so Gemini can't cluster
        // them - group them here instead, using the copies we already decrypted for
        // display, then re-encrypt the result before it leaves the browser (E2E-4).
        const plainClusters = clusterQuestions(submissions.map(s => ({ id: s.id, content: s.content })));
        if (plainClusters.length === 0) throw new Error("No submissions to cluster.");
        const encryptedClusters = await Promise.all(plainClusters.map(encryptCluster));

        const res = await fetch(`${apiBase}/api/sessions/${code}/cluster`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clusters: encryptedClusters }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        setClusters(await Promise.all((data.clusters ?? []).map(readCluster)));
        setPhase("RESULTS");
        return;
      }

      const res = await fetch(`${apiBase}/api/sessions/${code}/cluster`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setClusters(data.clusters);
      setPhase("RESULTS");
    } catch (err) {
      setError(err.message);
      setPhase("CLOSED");
    } finally {
      setActionLoading(false);
    }
  }

  // trash button on a cluster. removed locally right away, the server's cluster:deleted
  // broadcast then tells the participants.
  async function deleteCluster(clusterId) {
    try {
      await fetch(`${apiBase}/api/sessions/${code}/clusters/${clusterId}`, { method: "DELETE" });
      setClusters(prev => prev.filter(c => c.id !== clusterId));
    } catch {
      setError("Failed to delete cluster.");
    }
  }

  // host adds a question to a specific cluster by hand. encrypted rooms send ciphertext
  // plus a nonce, same shape participants use. the state update comes back through
  // cluster:submission:added, so there's nothing to set here except clearing the input.
  async function submitManualQuestion(clusterId, question) {
    try {
      let payload = { content: question };
      if (encrypted) {
        const { roomKey } = await ensureHostKeys();
        const { ciphertext, nonce } = await encryptText(roomKey, question);
        payload = { content: ciphertext, nonce };
      }
      await fetch(`${apiBase}/api/sessions/${code}/clusters/${clusterId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setManualQuestions(prev => ({ ...prev, [clusterId]: "" }));
    } catch {
      setError("Failed to submit manual question.");
    }
  }

  // saves the host's answer to a cluster. the id is either a bare cluster id or
  // "<id>::question", the second form goes to the same endpoint with ?question= so the
  // server files it as a participant answer. answers are plaintext, even in encrypted
  // rooms. the server then broadcasts cluster:answered (and drafts follow-up suggestions).
  async function saveAnswer(answerId) {
    const answer = answers[answerId] ?? "";
    const [clusterId, question] = answerId.includes("::")
      ? answerId.split("::")
      : [answerId, null];

    try {
      const url = question
        ? `/api/sessions/${code}/clusters/${clusterId}/answer?question=${encodeURIComponent(question)}`
        : `/api/sessions/${code}/clusters/${clusterId}/answer`;

      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      setEditingAnswer(null);
    } catch {
      setError("Failed to save answer.");
    }
  }

  // "End session". whatever phase we're in -> ENDED. the server sends everyone a summary
  // through session:ended, and the room stops taking anything.
  async function endSession() {
    setActionLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/sessions/${code}/end`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error);
      setPhase("ENDED");
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(false);
    }
  }

  // goes over the socket, not REST. nothing changes here until the server answers
  // with session:deleted, which is what sends us home.
  function deleteSession() {
    if (!socketRef.current) return;
    socketRef.current.emit("host:delete_session", { code });
  }

  // "Open second round". RESULTS -> EXPANDING: the server generates follow-up previews and
  // reopens submissions. expansion:preview arrives later and moves us back to RESULTS.
  async function openSecondRound() {
    setExpandLoading(true);
    setError("");
    try {
      const res = await fetch(`${apiBase}/api/sessions/${code}/expand`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPhase("EXPANDING");
    } catch (err) {
      setError(err.message ?? "Failed to open second round.");
    } finally {
      setExpandLoading(false);
    }
  }

  // promote or demote a participant from the list. the server flips it and the
  // curator:promoted broadcast tells everyone, we also apply the answer locally.
  async function toggleCurator(socketId) {
    try {
      const res = await fetch(`${apiBase}/api/sessions/${code}/curators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ socketId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setCurators(data.curators);
      setParticipants(prev =>
        prev.map(p => ({ ...p, isCurator: data.curators.includes(p.socketId) }))
      );
    } catch (err) {
      setError(err.message ?? "Failed to update curator.");
    }
  }

  // tags steer the clustering, so they get saved whenever they change. fire and forget,
  // a failure only gets logged.
  async function saveTags(updatedTags) {
    try {
      await fetch(`${apiBase}/api/sessions/${code}/tags`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: updatedTags }),
      });
    } catch (err) {
      console.error("Failed to save tags:", err);
    }
  }

  // ====================== UI Handlers ======================

  // Enter or comma in the tag box commits the tag, duplicates are ignored, then saveTags.
  function addTag(e) {
    if ((e.key === "Enter" || e.key === ",") && tagInput.trim()) {
      e.preventDefault();
      const t = tagInput.trim().replace(/,$/, "");
      if (t && !tags.includes(t)) {
        const updated = [...tags, t];
        setTags(updated);
        saveTags(updated);
      }
      setTagInput("");
    }
  }

  function removeTag(t) {
    const updated = tags.filter(x => x !== t);
    setTags(updated);
    saveTags(updated);
  }

  // ====================== Render ======================
  // header up top, controls and participants on the left, the cluster list in the middle.
  // HostList decides what to show based on phase, this component just feeds it.

  // only true while createSession is waiting on the server
  if (loading) {
    return (
      <div className="hd-loading">
        <div className="hd-loading-text">Creating session…</div>
      </div>
    );
  }

  return (
    <div className="hd-root">
      <HostHeader
        phase={phase}
        participantCount={participantCount}
        submissionCount={submissionCount}
        onBack={onBack}
        onOpenSidebar={onOpenSidebar}
        darkMode={darkMode}
        onToggleDark={onToggleDark}
        bgKey={bgKey}
        onSelectBg={onSelectBg}
      />

      {(title || description) && (
        <div className="hd-session-context">
          {title && <h2 className="hd-session-title">{title}</h2>}
          {description && <p className="hd-session-description">{description}</p>}
        </div>
      )}

      <div className="hd-body">
        <aside className="hd-sidebar-shell">
          <HostSidebar
            code={code}
            phase={phase}
            tags={tags}
            tagInput={tagInput}
            error={error}
            actionLoading={actionLoading}
            expandLoading={expandLoading}
            hostNotes={hostNotes}
            onNotesChange={setHostNotes}
            onTagInput={setTagInput}
            onAddTag={addTag}
            onRemoveTag={removeTag}
            canRecluster={phase === "RESULTS"}
            onClose={closeSubmissions}
            onCluster={triggerClustering}
            onTriggerExpansion={openSecondRound}
            onEndSession={endSession}
            onDeleteSession={deleteSession}
          />
          <ParticipantList
            participants={participants}
            curators={curators}
            onToggleCurator={toggleCurator}
          />
        </aside>

        <main className="hd-main">
          <HostList
            phase={phase}
            clusters={clusters}
            submissions={submissions}
            submissionCount={submissionCount}
            answers={answers}
            editingAnswer={editingAnswer}
            suggestedAnswers={suggestedAnswers}
            onDeleteCluster={deleteCluster}
            onSetEditingAnswer={setEditingAnswer}
            onAnswerChange={(id, val) => setAnswers(prev => ({ ...prev, [id]: val }))}
            onSaveAnswer={saveAnswer}
            onUseSuggestion={(clusterId, text) => {
              setAnswers(prev => ({ ...prev, [clusterId]: text }));
              setEditingAnswer(clusterId);
            }}
          />
        </main>
      </div>
    </div>
  );
}