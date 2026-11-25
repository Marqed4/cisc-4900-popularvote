// PipelineEditor.jsx: minimal host UI for the custom hash pipeline.
// An ordered list of steps with their parameters. Every change is checked with
// validatePipeline, same rules the pipeline module itself enforces.
import { validatePipeline, MAX_STEPS } from "../../lib/pipeline.js";

// op name -> its param field names, same shape pipeline.js expects.
const OP_PARAM_FIELDS = {
  substring: ["from", "to"],
  repeat: ["n"],
  salt: [],
  fnv: [],
  shiftLeft: ["n"],
  shiftRight: ["n"],
  and: ["mask"],
  xor: ["mask"],
  rotate: ["n"],
};
const OP_NAMES = Object.keys(OP_PARAM_FIELDS);

function blankStep(op) {
  const step = { op };
  for (const field of OP_PARAM_FIELDS[op]) step[field] = 0;
  return step;
}

export default function PipelineEditor({ value, onChange }) {
  const steps = value ?? [];
  const result = steps.length
    ? validatePipeline(steps)
    : { ok: false, reason: "pipeline must have at least one step" };

  const setStep = (i, next) => {
    const copy = steps.slice();
    copy[i] = next;
    onChange(copy);
  };
  const addStep = () => { if (steps.length < MAX_STEPS) onChange([...steps, blankStep("salt")]); };
  const removeStep = (i) => onChange(steps.filter((_, idx) => idx !== i));
  const moveStep = (i, delta) => {
    const j = i + delta;
    if (j < 0 || j >= steps.length) return;
    const copy = steps.slice();
    [copy[i], copy[j]] = [copy[j], copy[i]];
    onChange(copy);
  };

  return (
    <div className="pipeline-editor">
      <ol>
        {steps.map((step, i) => (
          <li key={i}>
            <select
              aria-label={`step ${i + 1} op`}
              value={step.op}
              onChange={(e) => setStep(i, blankStep(e.target.value))}
            >
              {OP_NAMES.map((op) => <option key={op} value={op}>{op}</option>)}
            </select>
            {OP_PARAM_FIELDS[step.op]?.map((field) => (
              <input
                key={field}
                aria-label={`step ${i + 1} ${field}`}
                type="number"
                value={step[field] ?? 0}
                onChange={(e) => setStep(i, { ...step, [field]: Number(e.target.value) })}
              />
            ))}
            <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0}>up</button>
            <button type="button" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1}>down</button>
            <button type="button" onClick={() => removeStep(i)}>remove</button>
          </li>
        ))}
      </ol>
      <button type="button" onClick={addStep} disabled={steps.length >= MAX_STEPS}>add step</button>
      {result.ok
        ? <p role="status">pipeline is valid</p>
        : <p role="alert">{result.reason}</p>}
    </div>
  );
}
