import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildResumedWorkerPrompt } from "./reports.js";
import { buildStepContext } from "./steps.js";
import { TaskStore } from "./store.js";
import type { TaskRecord, TaskStep } from "./types.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-steps-test-"));
  return path.join(dir, "tasks.sqlite");
}

// ---------------------------------------------------------------------------
// Store-level step methods
// ---------------------------------------------------------------------------

describe("TaskStore steps", () => {
  let store: TaskStore;
  let objId: string;
  let taskId: string;

  beforeEach(() => {
    store = new TaskStore(tmpDb());
    objId = store.createObjective({
      agentId: "main",
      title: "Step Test Objective",
      description: "test",
    });
    taskId = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "Step Test Task",
    });
  });

  afterEach(() => {
    store.close();
  });

  it("addStep inserts a step and returns an id", () => {
    const stepId = store.addStep(taskId, "fetch-data", { url: "https://example.com" });
    expect(stepId).toBeTruthy();
  });

  it("getSteps returns steps ordered by step_index", () => {
    store.addStep(taskId, "step-a", "result-a");
    store.addStep(taskId, "step-b", "result-b");
    store.addStep(taskId, "step-c", "result-c");

    const steps = store.getSteps(taskId);
    expect(steps).toHaveLength(3);
    expect(steps[0].stepName).toBe("step-a");
    expect(steps[0].stepIndex).toBe(0);
    expect(steps[1].stepName).toBe("step-b");
    expect(steps[1].stepIndex).toBe(1);
    expect(steps[2].stepName).toBe("step-c");
    expect(steps[2].stepIndex).toBe(2);
  });

  it("step results are preserved through JSON round-trip", () => {
    store.addStep(taskId, "analyze", { count: 42, items: ["a", "b"] });

    const steps = store.getSteps(taskId);
    expect(steps[0].result).toEqual({ count: 42, items: ["a", "b"] });
  });

  it("step with no result stores undefined", () => {
    store.addStep(taskId, "side-effect-only");

    const steps = store.getSteps(taskId);
    expect(steps[0].result).toBeUndefined();
  });

  it("getStepCount returns correct count", () => {
    expect(store.getStepCount(taskId)).toBe(0);

    store.addStep(taskId, "first");
    expect(store.getStepCount(taskId)).toBe(1);

    store.addStep(taskId, "second");
    expect(store.getStepCount(taskId)).toBe(2);
  });

  it("getStepCount returns 0 for unknown task", () => {
    expect(store.getStepCount("nonexistent-task-id")).toBe(0);
  });

  it("steps have correct status and timestamps", () => {
    const before = Date.now();
    store.addStep(taskId, "timed-step", "ok");
    const after = Date.now();

    const steps = store.getSteps(taskId);
    expect(steps[0].status).toBe("completed");
    expect(steps[0].createdAt).toBeGreaterThanOrEqual(before);
    expect(steps[0].createdAt).toBeLessThanOrEqual(after);
    expect(steps[0].completedAt).toBeGreaterThanOrEqual(before);
    expect(steps[0].completedAt).toBeLessThanOrEqual(after);
  });

  it("steps are scoped to their task", () => {
    const taskId2 = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "Other Task",
    });

    store.addStep(taskId, "task1-step");
    store.addStep(taskId2, "task2-step");

    expect(store.getSteps(taskId)).toHaveLength(1);
    expect(store.getSteps(taskId2)).toHaveLength(1);
    expect(store.getStepCount(taskId)).toBe(1);
    expect(store.getStepCount(taskId2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildStepContext
// ---------------------------------------------------------------------------

describe("buildStepContext", () => {
  it("returns empty string for no steps", () => {
    expect(buildStepContext([])).toBe("");
  });

  it("formats steps as numbered list", () => {
    const steps: TaskStep[] = [
      makeStep(0, "fetch-data", "Got 10 records"),
      makeStep(1, "analyze", "Found 3 anomalies"),
    ];

    const ctx = buildStepContext(steps);
    expect(ctx).toContain("## Completed steps from prior run:");
    expect(ctx).toContain("1. [fetch-data]: Got 10 records");
    expect(ctx).toContain("2. [analyze]: Found 3 anomalies");
  });

  it("shows (no result) for steps without results", () => {
    const steps: TaskStep[] = [makeStep(0, "side-effect")];

    const ctx = buildStepContext(steps);
    expect(ctx).toContain("1. [side-effect]: (no result)");
  });

  it("truncates long individual step results", () => {
    const longResult = "x".repeat(3000);
    const steps: TaskStep[] = [makeStep(0, "big-step", longResult)];

    const ctx = buildStepContext(steps);
    expect(ctx).toContain("... (truncated)");
    // Full 3000-char result should not appear
    expect(ctx).not.toContain(longResult);
  });

  it("serializes object results as JSON", () => {
    const steps: TaskStep[] = [makeStep(0, "obj-step", { key: "value" })];

    const ctx = buildStepContext(steps);
    expect(ctx).toContain('[obj-step]: {"key":"value"}');
  });

  it("summarizes when total context is too large", () => {
    // Create enough steps with long results to exceed 8000 chars
    const steps: TaskStep[] = [];
    for (let i = 0; i < 20; i++) {
      steps.push(makeStep(i, `step-${i}`, "y".repeat(500)));
    }

    const ctx = buildStepContext(steps);
    // Should be under the limit
    expect(ctx.length).toBeLessThanOrEqual(10000); // some margin for the summary format
    // Should contain the summarized header
    expect(ctx).toContain("summarized");
    // Some earlier steps should have "(result omitted)"
    expect(ctx).toContain("(result omitted)");
  });
});

// ---------------------------------------------------------------------------
// buildResumedWorkerPrompt
// ---------------------------------------------------------------------------

describe("buildResumedWorkerPrompt", () => {
  const baseTask: TaskRecord = {
    id: "task-123",
    agentId: "main",
    objectiveId: "obj-1",
    title: "Resumable Task",
    description: "A task that was suspended and is now resuming.",
    status: "running",
    priority: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    managerTrigger: "none",
    maxRetries: 0,
    retryCount: 0,
  };

  it("includes task title and ID", () => {
    const prompt = buildResumedWorkerPrompt(baseTask, [], []);
    expect(prompt).toContain("# Task: Resumable Task");
    expect(prompt).toContain("Task ID: task-123");
  });

  it("includes step context", () => {
    const steps: TaskStep[] = [
      makeStep(0, "research", "Found 5 papers"),
      makeStep(1, "outline", "Created draft outline"),
    ];

    const prompt = buildResumedWorkerPrompt(baseTask, [], steps);
    expect(prompt).toContain("## Completed steps from prior run:");
    expect(prompt).toContain("1. [research]: Found 5 papers");
    expect(prompt).toContain("2. [outline]: Created draft outline");
  });

  it("includes resume event data", () => {
    const prompt = buildResumedWorkerPrompt(baseTask, [], [], {
      approver: "admin",
      comment: "Looks good",
    });
    expect(prompt).toContain("## Resume event data");
    expect(prompt).toContain('"approver":"admin"');
  });

  it("includes resume instructions", () => {
    const prompt = buildResumedWorkerPrompt(baseTask, [], []);
    expect(prompt).toContain("You are resuming a previously suspended task");
    expect(prompt).toContain("Continue from where you left off");
  });

  it("includes dependency report summaries", () => {
    const prompt = buildResumedWorkerPrompt(
      baseTask,
      ["Prior task found 10 companies", "Analysis completed"],
      [],
    );
    expect(prompt).toContain("## Context from prior tasks:");
    expect(prompt).toContain("- Prior task found 10 companies");
    expect(prompt).toContain("- Analysis completed");
  });

  it("includes metadata", () => {
    const task: TaskRecord = {
      ...baseTask,
      metadata: { targetUrl: "https://example.com", maxPages: 5 },
    };

    const prompt = buildResumedWorkerPrompt(task, [], []);
    expect(prompt).toContain("## Task metadata");
    expect(prompt).toContain("targetUrl: https://example.com");
    expect(prompt).toContain("maxPages: 5");
  });

  it("includes skill assignment", () => {
    const task: TaskRecord = {
      ...baseTask,
      assignedSkill: "web-scraper",
    };

    const prompt = buildResumedWorkerPrompt(task, [], []);
    expect(prompt).toContain("You are assigned skill: web-scraper");
  });

  it("handles string resume event data", () => {
    const prompt = buildResumedWorkerPrompt(baseTask, [], [], "User approved the task");
    expect(prompt).toContain("## Resume event data");
    expect(prompt).toContain("User approved the task");
  });

  it("omits resume event section when data is undefined", () => {
    const prompt = buildResumedWorkerPrompt(baseTask, [], []);
    expect(prompt).not.toContain("## Resume event data");
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStep(index: number, name: string, result?: unknown): TaskStep {
  return {
    id: `step-${index}`,
    taskId: "task-123",
    stepName: name,
    stepIndex: index,
    status: "completed",
    result,
    createdAt: Date.now(),
    completedAt: Date.now(),
  };
}
