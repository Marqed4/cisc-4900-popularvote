import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";

import HostHeader from "./HostHeader";
import HostList from "./HostList";
import HostSidebar from "./HostSidebar.jsx";
import ParticipantList from "./ParticipantList";
import "./HostLayout.css";

export default function HostDashboard({ code: initialCode, initialTitle = '', initialDescription = '', onBack, onSessionCreated, onOpenSidebar, darkMode, onToggleDark, bgKey, onSelectBg }) {
  // Core session state
  const [phase, setPhase] = useState("OPEN");
  const [code, setCode] = useState(initialCode);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
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

  const socketRef  = useRef(null);
  const createdRef = useRef(false);
  const apiBase = import.meta.env.VITE_API_URL ?? "";

  // ====================== API & Session Management ======================
  // Defined BEFORE useEffects so closures can reference them safely.

  async function createSession() {
    setLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags, title: initialTitle, description: initialDescription }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setCode(data.code);
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

  // FIX: was using `initialCode` in the URL now uses the `code` state so
  // polling after a NEW session is created hits the right endpoint.
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
      setSubmissions(data.submissions ?? []);
      setSubmissionCount(data.submissionCount ?? 0);
      setSubmissionsAtLastCluster(data.submissionsAtLastCluster ?? 0);
      setParticipantCount(data.participantCount ?? 0);
      setClusters(data.clusters ?? []);
      setCurators(data.curators ?? []);

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

  // Initialize session
  useEffect(() => {
    if (initialCode === "NEW") {
      if (createdRef.current) return;
      createdRef.current = true;
      createSession();
    } else {
      fetchSession(initialCode);
    }
  }, []);

  // Socket connection and real-time listeners
  useEffect(() => {
    if (!code || code === "NEW") return;

    const socket = io(import.meta.env.VITE_API_URL ?? "http://localhost:2167");
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("join:room", { code, role: "host" });
    });

    socket.on("reconnect", () => {
      fetchSession(code);
    });

    socket.on("submission:count", ({ count }) => setSubmissionCount(count));
    socket.on("submission:new", ({ id, content }) => {
      setSubmissions(prev => [...prev, { id, content }]);
    });

    socket.on("session:closed", () => setPhase("CLOSED"));
    socket.on("session:clustering", () => setPhase("CLUSTERING"));
    socket.on("session:results", ({ clusters, submissionsAtLastCluster }) => {
      setClusters(clusters);
      if (submissionsAtLastCluster !== undefined) setSubmissionsAtLastCluster(submissionsAtLastCluster);
      setPhase("RESULTS");
    });

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

    socket.on("cluster:suggestions", ({ suggestions }) => {
      setSuggestedAnswers(prev => {
        const next = { ...prev };
        suggestions.forEach(({ clusterId, suggestion }) => {
          if (suggestion) next[clusterId] = suggestion;
        });
        return next;
      });
    });

    socket.on("session:ended", () => setPhase("ENDED"));
    socket.on("cluster:deleted", ({ clusterId }) =>
      setClusters(prev => prev.filter(c => c.id !== clusterId))
    );

    socket.on("cluster:answered", ({ clusterId, answer }) =>
      setAnswers(prev => ({ ...prev, [clusterId]: answer }))
    );

    socket.on("cluster:followup:answered", ({ clusterId, answer }) =>
      setAnswers(prev => ({ ...prev, [clusterId + "::followup"]: answer }))
    );

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

    socket.on("curator:updated", ({ curators: newCurators }) => {
      setCurators(newCurators);
      setParticipants(prev =>
        prev.map(p => ({ ...p, isCurator: newCurators.includes(p.socketId) }))
      );
    });

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

    socket.on("cluster:submission:added", ({ clusterId, question, submissionCount }) => {
      console.log("[cluster:submission:added]", { clusterId, question, submissionCount });
      setClusters(prev =>
        prev.map(c => {
          if (String(c.id) !== String(clusterId)) return c;
          return {
            ...c,
            submission_count: submissionCount,
            questions: [...(c.questions ?? []), question],
          };
        })
      );
    });

    // host triggered delete navigate away
    socket.on("session:deleted", () => onBack());

    return () => socket.disconnect();
  }, [code]);

  // Polling fallback
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

  async function triggerClustering() {
    if (submissionCount === 0) {
      setError("No submissions yet.");
      return;
    }
    setActionLoading(true);
    setError("");
    setPhase("CLUSTERING");

    try {
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

  async function deleteCluster(clusterId) {
    try {
      await fetch(`${apiBase}/api/sessions/${code}/clusters/${clusterId}`, { method: "DELETE" });
      setClusters(prev => prev.filter(c => c.id !== clusterId));
    } catch {
      setError("Failed to delete cluster.");
    }
  }

  async function submitManualQuestion(clusterId, question) {
    try {
      await fetch(`${apiBase}/api/sessions/${code}/clusters/${clusterId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: question }),
      });
      setManualQuestions(prev => ({ ...prev, [clusterId]: "" }));
    } catch {
      setError("Failed to submit manual question.");
    }
  }

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

  function deleteSession() {
    if (!socketRef.current) return;
    socketRef.current.emit("host:delete_session", { code });
  }

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