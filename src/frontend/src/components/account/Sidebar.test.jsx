import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { afterEach } from "vitest";

// every supabase call is recorded and answered from `tables`, so a test can see which columns
// the sidebar asked for and decide what comes back.
const calls = [];
let tables = {};

vi.mock("../../lib/supabase.js", () => {
  const builder = (table) => {
    const call = { table, select: null, filters: [] };
    calls.push(call);
    const chain = {
      select: (cols) => { call.select = cols; return chain; },
      update: () => chain,
      in: (...a) => { call.filters.push(["in", ...a]); return chain; },
      eq: (...a) => { call.filters.push(["eq", ...a]); return chain; },
      order: () => chain,
      then: (resolve, reject) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject),
    };
    return chain;
  };
  return { supabase: { from: builder } };
});

import Sidebar from "./Sidebar.jsx";

const row = (code, extra = {}) => ({
  code, phase: "OPEN", tags: [], title: `Room ${code}`, created_at: "2026-01-01T00:00:00Z", ...extra,
});

function renderSidebar(props = {}) {
  return render(
    <Sidebar open onClose={() => {}} user={null} onSignIn={() => {}} onSignOut={() => {}}
      onNavigate={() => {}} clearOnExit={false} onToggleClearOnExit={() => {}} {...props} />,
  );
}

beforeEach(() => {
  calls.length = 0;
  tables = {};
  localStorage.clear();
});
afterEach(cleanup);

describe("Sidebar tier badges (signed out)", () => {
  beforeEach(() => {
    localStorage.setItem("pv-my-sessions", JSON.stringify(["AAA111", "BBB222", "CCC333", "DDD444"]));
    tables.sessions = [
      row("AAA111", { encrypted: false, hashed_identity: false }),
      row("BBB222", { encrypted: true, hashed_identity: false }),
      row("CCC333", { encrypted: true, hashed_identity: true }),
      row("DDD444", { encrypted: null, hashed_identity: null }), // an old row from before the columns
    ];
  });

  it("shows one badge per tier, and old null rows as Normal", async () => {
    renderSidebar();

    await screen.findByText("Room AAA111");
    expect(screen.getAllByText("Normal")).toHaveLength(2);
    expect(screen.getAllByText("Encrypted")).toHaveLength(1);
    expect(screen.getAllByText("Hashed identity")).toHaveLength(1);
  });

  it("puts the right style class on each tier", async () => {
    renderSidebar();

    await screen.findByText("Room AAA111");
    expect(screen.getByText("Encrypted").className).toContain("sb-tier-e2e");
    expect(screen.getByText("Hashed identity").className).toContain("sb-tier-hashed");
    expect(screen.getAllByText("Normal")[0].className).toContain("sb-tier-normal");
  });

  it("explains each tier in a title, so color is never the only cue", async () => {
    renderSidebar();

    await screen.findByText("Room AAA111");
    expect(screen.getByText("Encrypted").title).toMatch(/cannot read questions/i);
    expect(screen.getByText("Hashed identity").title).toMatch(/linked across sessions/i);
    expect(screen.getAllByText("Normal")[0].title).toMatch(/readable on the server/i);
  });

  it("asks Supabase for both tier columns", async () => {
    renderSidebar();

    await screen.findByText("Room AAA111");
    const select = calls.find(c => c.table === "sessions").select;
    expect(select).toContain("encrypted");
    expect(select).toContain("hashed_identity");
  });

  it("treats encrypted=false with hashed_identity=true as Normal (hashed implies encrypted)", async () => {
    tables.sessions = [row("AAA111", { encrypted: false, hashed_identity: true })];
    renderSidebar();

    await screen.findByText("Room AAA111");
    expect(screen.getByText("Normal")).toBeTruthy();
    expect(screen.queryByText("Hashed identity")).toBeNull();
  });
});

describe("Sidebar tier badges (signed in)", () => {
  const user = { id: "user-1", email: "a@b.co" };

  beforeEach(() => {
    tables.user_sessions = [
      { session_code: "AAA111", role: "host", saved_at: "2026-01-02T00:00:00Z" },
      { session_code: "CCC333", role: "participant", saved_at: "2026-01-01T00:00:00Z" },
    ];
    tables.sessions = [
      row("AAA111", { encrypted: true, hashed_identity: false }),
      row("CCC333", { encrypted: true, hashed_identity: true }),
    ];
  });

  it("asks for both tier columns on the signed-in path too", async () => {
    renderSidebar({ user });

    await screen.findByText("Room AAA111");
    const select = calls.find(c => c.table === "sessions").select;
    expect(select).toContain("encrypted");
    expect(select).toContain("hashed_identity");
  });

  it("shows the badges for saved sessions", async () => {
    renderSidebar({ user });

    await screen.findByText("Room AAA111");
    expect(screen.getByText("Encrypted")).toBeTruthy();
    expect(screen.getByText("Hashed identity")).toBeTruthy();
    expect(screen.queryByText("Normal")).toBeNull();
  });
});

describe("Sidebar behavior around the badge", () => {
  beforeEach(() => {
    localStorage.setItem("pv-my-sessions", JSON.stringify(["AAA111"]));
    tables.sessions = [row("AAA111", { encrypted: true, hashed_identity: true })];
  });

  it("opens the session when the row is clicked", async () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    renderSidebar({ onNavigate, onClose });

    fireEvent.click(await screen.findByText("Room AAA111"));

    expect(onNavigate).toHaveBeenCalledWith("host", "AAA111");
    expect(onClose).toHaveBeenCalled();
  });

  it("dismiss removes the row without navigating", async () => {
    const onNavigate = vi.fn();
    renderSidebar({ onNavigate });
    await screen.findByText("Room AAA111");

    fireEvent.click(screen.getByLabelText("Remove from history"));

    await waitFor(() => expect(screen.queryByText("Room AAA111")).toBeNull());
    expect(onNavigate).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("pv-my-sessions"))).toEqual([]);
  });

  it("falls back to an empty list when the query errors out", async () => {
    tables.sessions = undefined;
    localStorage.setItem("pv-my-sessions", JSON.stringify(["AAA111"]));
    renderSidebar();

    expect(await screen.findByText(/No sessions yet/)).toBeTruthy();
  });
});
