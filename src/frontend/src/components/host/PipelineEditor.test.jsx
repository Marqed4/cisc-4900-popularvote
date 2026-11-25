import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import PipelineEditor from "./PipelineEditor.jsx";

afterEach(cleanup);

function setup(initial) {
  let steps = initial;
  const onChange = vi.fn((next) => { steps = next; });
  const utils = render(<PipelineEditor value={steps} onChange={onChange} />);
  return { onChange, ...utils };
}

describe("PipelineEditor", () => {
  it("shows an invalid message for an empty pipeline", () => {
    setup([]);
    expect(screen.getByRole("alert").textContent).toMatch(/at least one step/);
  });

  it("shows a valid message for a pipeline that passes validatePipeline", () => {
    setup([{ op: "salt" }]);
    expect(screen.getByRole("status").textContent).toMatch(/valid/);
  });

  it("shows the real reason for an invalid pipeline, same wording validatePipeline gives", () => {
    setup([{ op: "shiftLeft", n: 1 }]);
    expect(screen.getByRole("alert").textContent).toMatch(/needs number/);
  });

  it("adding a step calls onChange with one more step appended", () => {
    const { onChange } = setup([{ op: "salt" }]);
    fireEvent.click(screen.getByText("add step"));
    expect(onChange).toHaveBeenCalledWith([{ op: "salt" }, { op: "salt" }]);
  });

  it("removing a step calls onChange without it", () => {
    const { onChange } = setup([{ op: "salt" }, { op: "fnv" }]);
    fireEvent.click(screen.getAllByText("remove")[0]);
    expect(onChange).toHaveBeenCalledWith([{ op: "fnv" }]);
  });

  it("moving a step down swaps it with the next one", () => {
    const { onChange } = setup([{ op: "salt" }, { op: "fnv" }]);
    fireEvent.click(screen.getAllByText("down")[0]);
    expect(onChange).toHaveBeenCalledWith([{ op: "fnv" }, { op: "salt" }]);
  });

  it("the up button on the first step and the down button on the last step are disabled", () => {
    setup([{ op: "salt" }, { op: "fnv" }]);
    expect(screen.getAllByText("up")[0].disabled).toBe(true);
    expect(screen.getAllByText("down")[1].disabled).toBe(true);
  });

  it("changing the op in a step resets its params to a blank step for that op", () => {
    const { onChange } = setup([{ op: "repeat", n: 5 }]);
    fireEvent.change(screen.getByLabelText("step 1 op"), { target: { value: "salt" } });
    expect(onChange).toHaveBeenCalledWith([{ op: "salt" }]);
  });

  it("editing a param field updates only that field", () => {
    const { onChange } = setup([{ op: "repeat", n: 1 }]);
    fireEvent.change(screen.getByLabelText("step 1 n"), { target: { value: "4" } });
    expect(onChange).toHaveBeenCalledWith([{ op: "repeat", n: 4 }]);
  });

  it("add step is disabled once MAX_STEPS is reached", () => {
    const eight = Array.from({ length: 8 }, () => ({ op: "salt" }));
    setup(eight);
    expect(screen.getByText("add step").disabled).toBe(true);
  });
});
