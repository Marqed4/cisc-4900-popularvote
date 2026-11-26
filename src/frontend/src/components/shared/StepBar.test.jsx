import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import StepBar from "./StepBar.jsx";
import { hostGuide } from "../../lib/steps.js";

afterEach(cleanup);

function renderHost(phase, extra = {}, opts = {}) {
  const onAction = vi.fn();
  const g = hostGuide(phase, { submissionCount: 4, ...opts });
  render(<StepBar phase={phase} hint={g.hint} primary={g.primary} secondary={g.secondary} onAction={onAction} {...extra} />);
  return onAction;
}

describe("StepBar", () => {
  it("marks the current step and the finished ones", () => {
    renderHost("RESULTS");
    expect(screen.getByText("Answer").closest("li").getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Collect").closest("li").className).toContain("is-done");
    expect(screen.getByText("Wrap up").closest("li").className).not.toContain("is-done");
  });

  it("runs the main action with one click", () => {
    const onAction = renderHost("OPEN");
    fireEvent.click(screen.getByRole("button", { name: "Group questions" }));
    expect(onAction).toHaveBeenCalledWith("group");
  });

  it("asks before finishing, and only finishes on yes", () => {
    const onAction = renderHost("RESULTS");
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Yes, finish session/i }));
    expect(onAction).toHaveBeenCalledWith("end");
  });

  it("lets the host back out of a confirmation", () => {
    const onAction = renderHost("RESULTS");
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Finish session" })).toBeTruthy();
  });

  it("disables buttons while an action runs", () => {
    renderHost("OPEN", { busy: true });
    expect(screen.getByRole("button", { name: "Grouping…" }).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Stop accepting questions" }).disabled).toBe(true);
  });

  it("shows an error from the last action", () => {
    renderHost("OPEN", { error: "No submissions yet." });
    expect(screen.getByRole("alert").textContent).toBe("No submissions yet.");
  });

  it("is read only for participants: a hint and no buttons", () => {
    render(<StepBar phase="OPEN" hint="Send a question." />);
    expect(screen.getByText("Send a question.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
