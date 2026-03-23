import type { TaskStep } from "./types.js";

/** Maximum chars for a single step result in the context output. */
const STEP_RESULT_MAX_CHARS = 2000;

/** Maximum total chars for the combined step context block. */
const STEP_CONTEXT_MAX_CHARS = 8000;

/**
 * Format completed steps as LLM-readable context for injection into a
 * resumed worker prompt. Each step's result is truncated to avoid
 * overwhelming the context window.
 *
 * If the total formatted output exceeds the limit, earlier steps are
 * summarized (name-only) so the most recent steps keep full detail.
 */
export function buildStepContext(steps: TaskStep[]): string {
  if (steps.length === 0) {
    return "";
  }

  const lines = formatStepLines(steps);
  const full = `## Completed steps from prior run:\n${lines.join("\n")}`;

  if (full.length <= STEP_CONTEXT_MAX_CHARS) {
    return full;
  }

  // Over budget — summarize earlier steps, keep recent ones in full detail.
  return summarizeSteps(steps);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatStepLines(steps: TaskStep[]): string[] {
  return steps.map((step) => {
    const resultStr = formatResult(step.result);
    return `${step.stepIndex + 1}. [${step.stepName}]: ${resultStr}`;
  });
}

function formatResult(result: unknown): string {
  if (result === undefined || result === null) {
    return "(no result)";
  }
  const raw = typeof result === "string" ? result : JSON.stringify(result);
  if (raw.length <= STEP_RESULT_MAX_CHARS) {
    return raw;
  }
  return `${raw.slice(0, STEP_RESULT_MAX_CHARS)}... (truncated)`;
}

/**
 * When the full step context is too large, compress earlier steps to
 * name-only summaries and keep the last few steps with full results.
 */
function summarizeSteps(steps: TaskStep[]): string {
  const header = "## Completed steps from prior run (summarized):";

  // Build lines from the end until we'd exceed budget
  const detailedLines: string[] = [];
  const summaryLines: string[] = [];
  let detailedLen = header.length + 1; // +1 for newline after header

  // Walk backward, keeping full detail for recent steps
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const resultStr = formatResult(step.result);
    const line = `${step.stepIndex + 1}. [${step.stepName}]: ${resultStr}`;

    if (detailedLen + line.length + 1 < STEP_CONTEXT_MAX_CHARS * 0.8) {
      detailedLines.unshift(line);
      detailedLen += line.length + 1;
    } else {
      // Summarize remaining earlier steps
      summaryLines.unshift(`${step.stepIndex + 1}. [${step.stepName}]: (result omitted)`);
    }
  }

  return `${header}\n${[...summaryLines, ...detailedLines].join("\n")}`;
}
