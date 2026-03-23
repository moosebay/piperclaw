import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "./store.js";

/**
 * Tests for the fallback report capture logic used by
 * notifyTaskCompletionFromSubagent(). The actual function lives in service.ts
 * and depends on heavy subagent imports, so we exercise the same store-level
 * pattern here to keep tests fast and isolated.
 */

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-service-test-"));
  return path.join(dir, "tasks.sqlite");
}

/**
 * Mirrors the fallback report capture logic from
 * notifyTaskCompletionFromSubagent() in service.ts.
 */
function applyFallbackReportCapture(
  store: TaskStore,
  taskId: string,
  status: "completed" | "failed",
  frozenResultText?: string,
): void {
  if (status !== "completed") {
    return;
  }
  if (!frozenResultText?.trim()) {
    return;
  }
  const existing = store.getReportByTask(taskId);
  if (existing) {
    return;
  }
  const task = store.getTask(taskId);
  if (!task) {
    return;
  }
  store.createReport({
    taskId,
    title: `Auto-captured: ${task.title}`,
    summary: frozenResultText.trim().slice(0, 300),
    content: frozenResultText,
    format: "markdown",
    metadata: { source: "fallback-capture" },
  });
}

describe("fallback report capture", () => {
  let store: TaskStore;
  let objId: string;

  beforeEach(() => {
    store = new TaskStore(tmpDb());
    objId = store.createObjective({
      agentId: "main",
      title: "Test objective",
      description: "test",
    });
  });

  afterEach(() => {
    store.close();
  });

  /** Create a task, promote to running, complete it, return task info. */
  function completeTaskWithStatus(
    title: string,
    status: "completed" | "failed",
    frozenResultText?: string,
  ) {
    const taskId = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title,
    });
    store.updateTaskStatus(taskId, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(taskId, runId);
    store.completeTask(taskId, runId, status, undefined, status === "failed" ? "err" : undefined);

    applyFallbackReportCapture(store, taskId, status, frozenResultText);
    return { taskId, runId };
  }

  it("creates a fallback report when task completes without one and frozenResultText is provided", () => {
    const { taskId } = completeTaskWithStatus(
      "Research companies",
      "completed",
      "Here are 5 companies I found...",
    );

    const report = store.getReportByTask(taskId);
    expect(report).toBeDefined();
    expect(report!.title).toBe("Auto-captured: Research companies");
    expect(report!.content).toBe("Here are 5 companies I found...");
    expect(report!.metadata).toEqual({ source: "fallback-capture" });

    // Task should also have the report linked via createReport()
    const task = store.getTask(taskId)!;
    expect(task.reportId).toBe(report!.id);
  });

  it("does not create a duplicate report when one already exists", () => {
    const taskId = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "With existing report",
    });
    store.updateTaskStatus(taskId, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(taskId, runId);

    // Worker created a report before completion
    store.createReport({
      taskId,
      title: "Worker Report",
      summary: "Done",
      content: "Full worker output",
    });

    store.completeTask(taskId, runId, "completed");
    applyFallbackReportCapture(store, taskId, "completed", "Some frozen text");

    // Should still have only the original report
    const reports = store.getReportsByObjective(objId);
    expect(reports.length).toBe(1);
    expect(reports[0].title).toBe("Worker Report");
  });

  it("does not create a fallback report when frozenResultText is undefined", () => {
    const { taskId } = completeTaskWithStatus("No output", "completed", undefined);

    const report = store.getReportByTask(taskId);
    expect(report).toBeUndefined();
  });

  it("does not create a fallback report when frozenResultText is empty/whitespace", () => {
    const { taskId } = completeTaskWithStatus("Blank output", "completed", "   ");

    const report = store.getReportByTask(taskId);
    expect(report).toBeUndefined();
  });

  it("does not create a fallback report on failed tasks", () => {
    const { taskId } = completeTaskWithStatus("Failed task", "failed", "Some output before crash");

    const report = store.getReportByTask(taskId);
    expect(report).toBeUndefined();
  });

  it("truncates summary to 300 characters", () => {
    const longText = "A".repeat(500);
    const { taskId } = completeTaskWithStatus("Long output", "completed", longText);

    const report = store.getReportByTask(taskId);
    expect(report).toBeDefined();
    expect(report!.summary.length).toBe(300);
    expect(report!.content.length).toBe(500);
  });
});
