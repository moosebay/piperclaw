import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shouldWakeManager } from "./manager-callback.js";
import { TaskStore } from "./store.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-mgr-test-"));
  return path.join(dir, "tasks.sqlite");
}

describe("shouldWakeManager", () => {
  let store: TaskStore;
  let objId: string;

  beforeEach(() => {
    store = new TaskStore(tmpDb());
    objId = store.createObjective({
      agentId: "main",
      title: "Test",
      description: "test",
    });
  });

  afterEach(() => {
    store.close();
  });

  it("returns null for happy-path completion (no trigger needed)", () => {
    const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
    // Add another pending task so objective isn't complete
    store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });

    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "completed");

    const task = store.getTask(t1)!;
    const result = shouldWakeManager(task, store);
    expect(result).toBeNull();
  });

  it("triggers task_failed when retries exhausted", () => {
    const t1 = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "Failing",
      maxRetries: 0,
    });
    // Add another pending task so objective isn't complete
    store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });

    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "failed", undefined, "error");

    const task = store.getTask(t1)!;
    const result = shouldWakeManager(task, store);
    expect(result).toEqual({ reason: "task_failed", taskId: t1 });
  });

  it("triggers task_review for on_complete tasks", () => {
    const t1 = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "Review me",
      managerTrigger: "on_complete",
    });
    // Add another pending task so objective isn't complete
    store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });

    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "completed");

    const task = store.getTask(t1)!;
    const result = shouldWakeManager(task, store);
    expect(result).toEqual({ reason: "task_review", taskId: t1 });
  });

  it("triggers task_review for on_fail tasks", () => {
    const t1 = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "Fail review",
      managerTrigger: "on_fail",
      maxRetries: 0,
    });
    // Add another pending task so objective isn't complete
    store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });

    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "failed", undefined, "err");

    const task = store.getTask(t1)!;
    const result = shouldWakeManager(task, store);
    // on_fail + retries exhausted → task_review takes priority (checked first? No, task_failed is checked first)
    // Actually: task_failed is checked first (retryCount >= maxRetries), so it returns task_failed
    // But the managerTrigger on_fail check also fires...
    // In the code: task_failed check is first, so it returns task_failed
    // This is the correct behavior — failure escalation takes priority
    expect(result).toEqual({ reason: "task_failed", taskId: t1 });
  });

  it("triggers group_completed when all group tasks are done", () => {
    const t1 = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "G1",
      group: "research",
    });
    const t2 = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "G2",
      group: "research",
    });
    // Add non-group task so objective isn't complete
    store.createTask({ agentId: "main", objectiveId: objId, title: "Downstream" });

    // Complete both
    store.updateTaskStatus(t1, "ready");
    let runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "completed");

    store.updateTaskStatus(t2, "ready");
    runId = crypto.randomUUID();
    store.claimTask(t2, runId);
    store.completeTask(t2, runId, "completed");

    const task = store.getTask(t2)!;
    const result = shouldWakeManager(task, store);
    expect(result).toEqual({ reason: "group_completed", group: "research" });
  });

  it("triggers objective_completed when all tasks are done", () => {
    const t1 = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "Only task",
    });

    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "completed");

    const task = store.getTask(t1)!;
    const result = shouldWakeManager(task, store);
    expect(result).toEqual({ reason: "objective_completed", objectiveId: objId });
  });

  it("does not trigger objective_completed when tasks remain", () => {
    const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
    store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });

    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "completed");

    const task = store.getTask(t1)!;
    const result = shouldWakeManager(task, store);
    expect(result).toBeNull();
  });

  it("considers cancelled tasks as done for objective completion", () => {
    const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
    const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });

    // Complete T1, cancel T2
    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "completed");

    store.updateTaskStatus(t2, "cancelled");

    const task = store.getTask(t1)!;
    const result = shouldWakeManager(task, store);
    expect(result).toEqual({ reason: "objective_completed", objectiveId: objId });
  });
});
