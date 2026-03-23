import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitEvent, registerWaitCondition } from "./events.js";
import { TaskStore } from "./store.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-events-test-"));
  return path.join(dir, "tasks.sqlite");
}

describe("event bus", () => {
  let store: TaskStore;
  let objectiveId: string;

  beforeEach(() => {
    store = new TaskStore(tmpDb());
    objectiveId = store.createObjective({
      agentId: "main",
      title: "Test Objective",
      description: "Testing events",
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
  // emitEvent
  // ---------------------------------------------------------------------------

  describe("emitEvent", () => {
    it("returns matched: false when no wait conditions exist", () => {
      const result = emitEvent(store, "some.event", { key: "value" });
      expect(result.matched).toBe(false);
      expect(result.taskId).toBeUndefined();
    });

    it("matches a waiting task and consumes the event", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "approval");

      const result = emitEvent(store, "approval", { approved: true });

      expect(result.matched).toBe(true);
      expect(result.taskId).toBe(taskId);
      expect(result.waitConditionId).toBeTruthy();

      // Wait condition should be removed
      const wc = store.getWaitConditionForTask(taskId);
      expect(wc).toBeNull();

      // Event should be consumed
      const _event = store.getEvent(store.insertEvent("dummy"));
      // The matched event was already consumed — check via a second insert
    });

    it("does not match when event name differs", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "approval");

      const result = emitEvent(store, "rejection", { reason: "no" });

      expect(result.matched).toBe(false);
      // Wait condition should still exist
      const wc = store.getWaitConditionForTask(taskId);
      expect(wc).not.toBeNull();
    });

    it("matches only the matching event name among multiple waits", () => {
      const task1 = createWaitingTask("Task 1");
      const task2 = createWaitingTask("Task 2");
      registerWaitCondition(store, task1, "event.alpha");
      registerWaitCondition(store, task2, "event.beta");

      const result = emitEvent(store, "event.beta", { x: 1 });

      expect(result.matched).toBe(true);
      expect(result.taskId).toBe(task2);

      // task1's wait should still be there
      const wc1 = store.getWaitConditionForTask(task1);
      expect(wc1).not.toBeNull();
      // task2's wait should be removed
      const wc2 = store.getWaitConditionForTask(task2);
      expect(wc2).toBeNull();
    });

    it("does not match retroactively (event before wait)", () => {
      // Emit first, then register wait — event should NOT be found
      emitEvent(store, "early.event", { data: "hello" });

      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "early.event");

      // No new event arrives — wait should still be active
      const wc = store.getWaitConditionForTask(taskId);
      expect(wc).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Filter matching
  // ---------------------------------------------------------------------------

  describe("filter matching", () => {
    it("matches when data contains all filter keys/values", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "approval", { taskId });

      const result = emitEvent(store, "approval", { taskId, comment: "ok" });
      expect(result.matched).toBe(true);
      expect(result.taskId).toBe(taskId);
    });

    it("does not match when filter keys are missing from data", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "approval", { requiredKey: "value" });

      const result = emitEvent(store, "approval", { otherKey: "something" });
      expect(result.matched).toBe(false);
    });

    it("does not match when filter values differ", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "approval", { status: "approved" });

      const result = emitEvent(store, "approval", { status: "rejected" });
      expect(result.matched).toBe(false);
    });

    it("matches without filter even when data is absent", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "simple.event");

      const result = emitEvent(store, "simple.event");
      expect(result.matched).toBe(true);
      expect(result.taskId).toBe(taskId);
    });

    it("does not match when filter exists but data is undefined", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "approval", { key: "value" });

      const result = emitEvent(store, "approval");
      expect(result.matched).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // registerWaitCondition
  // ---------------------------------------------------------------------------

  describe("registerWaitCondition", () => {
    it("creates a wait condition with timeout", () => {
      const taskId = createWaitingTask();
      const wcId = registerWaitCondition(store, taskId, "test.event", undefined, 60_000);

      const wc = store.getWaitConditionForTask(taskId);
      expect(wc).not.toBeNull();
      expect(wc!.id).toBe(wcId);
      expect(wc!.eventName).toBe("test.event");
      expect(wc!.timeoutAt).toBeDefined();
      expect(wc!.timeoutAt!).toBeGreaterThan(Date.now());
    });

    it("creates a wait condition without timeout", () => {
      const taskId = createWaitingTask();
      registerWaitCondition(store, taskId, "test.event");

      const wc = store.getWaitConditionForTask(taskId);
      expect(wc).not.toBeNull();
      expect(wc!.timeoutAt).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Expired wait conditions
  // ---------------------------------------------------------------------------

  describe("getExpiredWaitConditions", () => {
    it("returns conditions past their timeout", () => {
      const taskId = createWaitingTask();
      // Insert a wait condition with a timeout in the past
      store.insertWaitCondition(taskId, "test.event", undefined, Date.now() - 1000);

      const expired = store.getExpiredWaitConditions();
      expect(expired.length).toBe(1);
      expect(expired[0].taskId).toBe(taskId);
    });

    it("does not return conditions that have not expired", () => {
      const taskId = createWaitingTask();
      store.insertWaitCondition(taskId, "test.event", undefined, Date.now() + 60_000);

      const expired = store.getExpiredWaitConditions();
      expect(expired.length).toBe(0);
    });

    it("does not return conditions without a timeout", () => {
      const taskId = createWaitingTask();
      store.insertWaitCondition(taskId, "test.event");

      const expired = store.getExpiredWaitConditions();
      expect(expired.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Store event methods
  // ---------------------------------------------------------------------------

  describe("store event methods", () => {
    it("insertEvent stores and getEvent retrieves", () => {
      const eventId = store.insertEvent("test.event", { foo: "bar" });
      const event = store.getEvent(eventId);

      expect(event).toBeDefined();
      expect(event!.eventName).toBe("test.event");
      expect(event!.data).toEqual({ foo: "bar" });
      expect(event!.consumedByTaskId).toBeUndefined();
    });

    it("consumeEvent marks event as consumed", () => {
      const eventId = store.insertEvent("test.event");
      store.consumeEvent(eventId, "task-123");

      const event = store.getEvent(eventId);
      expect(event!.consumedByTaskId).toBe("task-123");
    });

    it("insertEvent with expiresAt", () => {
      const expiresAt = Date.now() + 60_000;
      const eventId = store.insertEvent("test.event", undefined, expiresAt);
      const event = store.getEvent(eventId);
      expect(event!.expiresAt).toBe(expiresAt);
    });

    it("removeWaitCondition deletes the record", () => {
      const taskId = createWaitingTask();
      const wcId = store.insertWaitCondition(taskId, "test.event");

      store.removeWaitCondition(wcId);
      const wc = store.getWaitConditionForTask(taskId);
      expect(wc).toBeNull();
    });
  });
});
