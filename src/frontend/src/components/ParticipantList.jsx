import "./ParticipantList.css";

export default function ParticipantList({ participants, curators, onToggleCurator }) {
  if (participants.length === 0) return null;

  return (
    <section className="hd-card">
      <div className="hd-card-title">Participants</div>
      <div className="hd-participant-list">
        {participants.map(p => (
          <div key={p.socketId} className="hd-participant-row">
            <div className="hd-participant-id">
              <span className={`hd-participant-dot ${p.isCurator ? "curator" : ""}`} />
              <span className="hd-participant-label">
                {p.socketId.slice(0, 8)}…
                {p.isCurator && <span className="hd-curator-badge">curator</span>}
              </span>
            </div>
            <button
              className={`hd-btn-curator ${p.isCurator ? "active" : ""}`}
              onClick={() => onToggleCurator(p.socketId)}
              title={p.isCurator ? "Revoke curator" : "Make curator"}
            >
              {p.isCurator ? "revoke" : "curate"}
            </button>
          </div>
        ))}
      </div>
      {curators.length > 0 && (
        <div className="hd-curator-note">
          Curators are certified to answer, but everyone can still participate.
        </div>
      )}
    </section>
  );
}