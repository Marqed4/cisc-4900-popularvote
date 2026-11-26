import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import HostSidebar from "./HostSidebar.jsx";
import { NOTES_MAX_CHARS } from "../../lib/limits.js";

vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn() } }));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSidebar(hostNotes = "") {
  const onNotesChange = vi.fn();
  const view = render(
    <HostSidebar code="ABC123" phase="OPEN" tags={[]} tagInput="" hostNotes={hostNotes}
      onNotesChange={onNotesChange} onTagInput={() => {}} onAddTag={() => {}} onRemoveTag={() => {}} onDeleteSession={() => {}} />,
  );
  return { ...view, onNotesChange };
}

const saveButton = () => screen.getByRole("button", { name: /save notes/i });
const textarea = () => screen.getByPlaceholderText(/paste speaker notes/i);

function uploadPdf(container, extracted) {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ extracted }) });
  const input = container.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [new File(["x"], "notes.pdf", { type: "application/pdf" })] } });
}

describe("host notes limit", () => {
  it("shows a counter against the limit", () => {
    renderSidebar("hello");

    expect(screen.getByText(`5 / ${NOTES_MAX_CHARS.toLocaleString()}`)).toBeTruthy();
  });

  it("tells the host the limits before they hit one", () => {
    renderSidebar();

    expect(screen.getByText(new RegExp(`${NOTES_MAX_CHARS.toLocaleString()} characters`))).toBeTruthy();
    expect(screen.getByText(/PDFs up to 50 pages/)).toBeTruthy();
  });

  it("turns the counter into a warning and blocks Save when over the limit", () => {
    renderSidebar("a".repeat(NOTES_MAX_CHARS + 25));

    const counter = screen.getByText(/25 over/);
    expect(counter.className).toContain("hd-notes-count--over");
    expect(saveButton().disabled).toBe(true);
  });

  it("allows Save at exactly the limit", () => {
    renderSidebar("a".repeat(NOTES_MAX_CHARS));

    expect(saveButton().disabled).toBe(false);
  });

  it("re-enables Save once the host trims the notes under the limit", () => {
    renderSidebar("a".repeat(NOTES_MAX_CHARS + 1));
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(textarea(), { target: { value: "a".repeat(NOTES_MAX_CHARS - 10) } });

    expect(saveButton().disabled).toBe(false);
  });

  it("saves the notes with a PATCH", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true }) });
    const { onNotesChange } = renderSidebar("short notes");

    fireEvent.click(saveButton());

    await waitFor(() => expect(onNotesChange).toHaveBeenCalledWith("short notes"));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/sessions/ABC123/notes");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({ hostNotes: "short notes" });
  });

  it("shows the server's message if a save is refused", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Notes are 31,000 characters. The limit is 30,000." }) });
    renderSidebar("short notes");

    fireEvent.click(saveButton());

    expect(await screen.findByText(/The limit is 30,000/)).toBeTruthy();
  });
});

describe("adding a PDF", () => {
  it("appends the extracted text after the notes when it fits", async () => {
    const { container } = renderSidebar("my notes");

    uploadPdf(container, "from the pdf");

    await waitFor(() => expect(textarea().value).toBe("my notes\n\n---\n\nfrom the pdf"));
  });

  it("does not append text that would pass the limit, and says why", async () => {
    const { container } = renderSidebar("a".repeat(NOTES_MAX_CHARS - 100));

    uploadPdf(container, "b".repeat(500));

    expect(await screen.findByText(/That PDF has 500 characters and only/)).toBeTruthy();
    expect(textarea().value).toBe("a".repeat(NOTES_MAX_CHARS - 100));
  });

  it("shows the server's page-limit message", async () => {
    const { container } = renderSidebar();
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "PDF has 80 pages. The limit is 50." }) });

    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [new File(["x"], "big.pdf", { type: "application/pdf" })] },
    });

    expect(await screen.findByText(/PDF has 80 pages/)).toBeTruthy();
  });
});
