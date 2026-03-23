import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWaitCondition } from "./events.js";
import { approveTask, rejectTask } from "./hitl.js";
import { TaskStore } from "./store.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-hitl-test-"));
  return path.join(dir, "tasks.sqlite");
}

describe("HITL approval flow", () => {
  let store: TaskStore;
  let objectiveId: string;

  beforeEach(() => {
    store = new TaskStore(tmpDb());
    objectiveId = store.createObjective({
      agentId: "main",
      title: "Test Objective",
      description: "Testing HITL",
    });
  });

  afterEach(() => {
    store.close();
  });

  // Helper: create a task and transition it to waiting
  function createWaitingTask(title = "Test Task"): string {
    const taskId = store.createTask({
      agentId: "main",
      objectiveId,
      title,
    });
    // pending -> ready -> running -> waiting
    store.updateTaskStatus(taskId, "ready");
    store.claimTask(taskId, "run-1");
    store.updateTaskStatus(taskId, "waiting");
    return taskId;
  }

  // ---------------------------------------------------------------------------
  // approveTask
  // ---------------------------------------------------------------------------

  describe("approveTask", () => {
    it("emits hitl.approve event with taskId in data", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "hitl.approve", { taskId });

      const result = approveTask(store, taskId, "alice", "looks good");

      expect(result.matched).toBe(true);
      expect(result.waitConditionId).toBeTruthy();

      // Wait condition should be consumed
      const wc = store.getWaitConditionForTask(taskId);
      expect(wc).toBeNull();
    });

    it("matches a task waiting for hitl.approve with matching taskId filter", () => {
      const task1 = createWaitingTask("Task A");
      const task2 = createWaitingTask("Task B");
      registerWaitCondition(store, task1, "hitl.approve", { taskId: task1 });
      registerWaitCondition(store, task2, "hitl.approve", { taskId: task2 });

      // Approve only task2
      const result = approveTask(store, task2, "bob");

      expect(result.matched).toBe(true);

      // task1's wait should still be active
      const wc1 = store.getWaitConditionForTask(task1);
      expect(wc1).not.toBeNull();

      // task2's wait should be consumed
      const wc2 = store.getWaitConditionForTask(task2);
      expect(wc2).toBeNull();
    });

    it("does not match a task waiting for a different event name", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "data.ready", { taskId });

      const result = approveTask(store, taskId, "alice");

      expect(result.matched).toBe(false);

      // Wait condition should still be active
      const wc = store.getWaitConditionForTask(taskId);
      expect(wc).not.toBeNull();
    });

    it("returns matched: false when no wait conditions exist", () => {
      const taskId = createWaitingTask();
      // No wait condition registered

      const result = approveTask(store, taskId, "alice");

      expect(result.matched).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // rejectTask
  // ---------------------------------------------------------------------------

  describe("rejectTask", () => {
    it("emits hitl.reject event with taskId in data", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "hitl.reject", { taskId });

      const result = rejectTask(store, taskId, "alice", "not ready");

      expect(result.matched).toBe(true);
      expect(result.waitConditionId).toBeTruthy();

      // Wait condition should be consumed
      const wc = store.getWaitConditionForTask(taskId);
      expect(wc).toBeNull();
    });

    it("stores reason in event data", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "hitl.reject", { taskId });

      const result = rejectTask(store, taskId, "bob", "insufficient data");

      expect(result.matched).toBe(true);
    });

    it("does not match a task waiting for hitl.approve", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "hitl.approve", { taskId });

      const result = rejectTask(store, taskId, "alice", "nope");

      expect(result.matched).toBe(false);

      // Wait condition should still be active
      const wc = store.getWaitConditionForTask(taskId);
      expect(wc).not.toBeNull();
    });

    it("returns matched: false when no wait conditions exist", () => {
      const taskId = createWaitingTask();

      const result = rejectTask(store, taskId, "alice", "bad");

      expect(result.matched).toBe(false);
    });
  });
});
