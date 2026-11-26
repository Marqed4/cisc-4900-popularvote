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

describe("Sidebar privacy badges (signed out)", () => {
  beforeEach(() => {
    localStorage.setItem("pv-my-sessions", JSON.stringify(["AAA111", "BBB222", "CCC333", "DDD444"]));
    tables.sessions = [
      row("AAA111", { privacy_mode: "standard" }),
      row("BBB222", { privacy_mode: "encrypted" }),
      row("CCC333", { privacy_mode: "passcode" }),
      row("DDD444", { privacy_mode: null }), // a row with no mode recorded
    ];
  });

  it("shows one badge per mode, and rows with no mode as Standard", async () => {
    renderSidebar();

    await screen.findByText("Room AAA111");
    expect(screen.getAllByText("Standard")).toHaveLength(2);
    expect(screen.getAllByText("Encrypted")).toHaveLength(1);
    expect(screen.getAllByText("Passcode")).toHaveLength(1);
  });

  it("puts the right style class on each mode", async () => {
    renderSidebar();

    await screen.findByText("Room AAA111");
    expect(screen.getByText("Encrypted").className).toContain("sb-tier-encrypted");
    expect(screen.getByText("Passcode").className).toContain("sb-tier-passcode");
    expect(screen.getAllByText("Standard")[0].className).toContain("sb-tier-standard");
  });

  it("explains each mode in a title, so color is never the only cue", async () => {
    renderSidebar();

    await screen.findByText("Room AAA111");
    expect(screen.getByText("Encrypted").title).toMatch(/cannot read questions/i);
    expect(screen.getByText("Passcode").title).toMatch(/needs the passcode|everyone needs the passcode/i);
    expect(screen.getAllByText("Standard")[0].title).toMatch(/server can read questions/i);
  });

  it("asks Supabase for the privacy_mode column, not the old flags", async () => {
    renderSidebar();

    await screen.findByText("Room AAA111");
    const select = calls.find(c => c.table === "sessions").select;
    expect(select).toContain("privacy_mode");
    expect(select).not.toContain("hashed_identity");
  });

  it("reads an unknown mode as Standard instead of guessing a stronger one", async () => {
    tables.sessions = [row("AAA111", { privacy_mode: "bogus" })];
    renderSidebar();

    await screen.findByText("Room AAA111");
    expect(screen.getByText("Standard")).toBeTruthy();
    expect(screen.queryByText("Passcode")).toBeNull();
  });
});

describe("Sidebar privacy badges (signed in)", () => {
  const user = { id: "user-1", email: "a@b.co" };

  beforeEach(() => {
    tables.user_sessions = [
      { session_code: "AAA111", role: "host", saved_at: "2026-01-02T00:00:00Z" },
      { session_code: "CCC333", role: "participant", saved_at: "2026-01-01T00:00:00Z" },
    ];
    tables.sessions = [
      row("AAA111", { privacy_mode: "encrypted" }),
      row("CCC333", { privacy_mode: "passcode" }),
    ];
  });

  it("asks for privacy_mode on the signed-in path too", async () => {
    renderSidebar({ user });

    await screen.findByText("Room AAA111");
    const select = calls.find(c => c.table === "sessions").select;
    expect(select).toContain("privacy_mode");
    expect(select).not.toContain("hashed_identity");
  });

  it("shows the badges for saved sessions", async () => {
    renderSidebar({ user });

    await screen.findByText("Room AAA111");
    expect(screen.getByText("Encrypted")).toBeTruthy();
    expect(screen.getByText("Passcode")).toBeTruthy();
    expect(screen.queryByText("Standard")).toBeNull();
  });
});

describe("Sidebar behavior around the badge", () => {
  beforeEach(() => {
    localStorage.setItem("pv-my-sessions", JSON.stringify(["AAA111"]));
    tables.sessions = [row("AAA111", { privacy_mode: "passcode" })];
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
