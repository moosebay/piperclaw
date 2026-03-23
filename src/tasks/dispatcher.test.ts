import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDispatcher, type DispatcherConfig } from "./dispatcher.js";
import { TaskStore } from "./store.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-dispatch-test-"));
  return path.join(dir, "tasks.sqlite");
}

type SpawnWorkerFn = DispatcherConfig["spawnWorker"];
type OnManagerWakeFn = DispatcherConfig["onManagerWake"];

describe("TaskDispatcher", () => {
  let store: TaskStore;
  let spawnWorker: SpawnWorkerFn;
  let onManagerWake: OnManagerWakeFn;
  let dispatcher: TaskDispatcher;
  let objId: string;

  beforeEach(() => {
    store = new TaskStore(tmpDb());
    spawnWorker = vi.fn<SpawnWorkerFn>().mockResolvedValue("mock-run-id");
    onManagerWake = vi.fn<OnManagerWakeFn>().mockResolvedValue(undefined);
    dispatcher = new TaskDispatcher(store, {
      tickIntervalMs: 100_000, // large interval — we tick manually
      maxConcurrent: 3,
      taskTimeoutMs: 60_000,
      spawnWorker,
      onManagerWake,
    });
    objId = store.createObjective({
      agentId: "main",
      title: "Test",
      description: "test",
    });
  });

  afterEach(() => {
    dispatcher.stop();
    store.close();
  });

  describe("dispatch", () => {
    it("claims and spawns worker for ready tasks on nudge", async () => {
      const t1 = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "T1",
      });

      // Promote to ready
      store.updateTaskStatus(t1, "ready");

      // Start and nudge
      dispatcher.start();
      // Give tick time to process
      await new Promise((r) => setTimeout(r, 50));

      expect(spawnWorker).toHaveBeenCalledTimes(1);
      const task = store.getTask(t1)!;
      expect(task.status).toBe("running");
    });

    it("respects maxConcurrent limit", async () => {
      const maxConcurrent = 2;
      dispatcher.stop();
      dispatcher = new TaskDispatcher(store, {
        tickIntervalMs: 100_000,
        maxConcurrent,
        taskTimeoutMs: 60_000,
        spawnWorker: vi.fn<SpawnWorkerFn>().mockResolvedValue("run"),
        onManagerWake,
      });

      store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      store.createTask({ agentId: "main", objectiveId: objId, title: "T3" });

      dispatcher.start();
      await new Promise((r) => setTimeout(r, 50));

      // Should only have dispatched maxConcurrent tasks
      expect(store.countRunningTasks()).toBeLessThanOrEqual(maxConcurrent);
    });
  });

  describe("handleTaskCompletion", () => {
    it("resolves dependents on successful completion", async () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      store.addDependency(t2, t1);

      // Complete T1
      store.updateTaskStatus(t1, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(t1, runId);
      store.completeTask(t1, runId, "completed");

      await dispatcher.handleTaskCompletion(t1);

      expect(store.getTask(t2)!.status).toBe("ready");
    });

    it("retries failed task when retries remain", async () => {
      const t1 = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Retryable",
        maxRetries: 2,
      });
      store.updateTaskStatus(t1, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(t1, runId);
      store.completeTask(t1, runId, "failed", undefined, "transient");

      await dispatcher.handleTaskCompletion(t1);

      const task = store.getTask(t1)!;
      expect(task.status).toBe("pending");
      expect(task.retryCount).toBe(1);
    });

    it("wakes manager on failure with retries exhausted", async () => {
      const t1 = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Fatal",
        maxRetries: 0,
      });
      store.updateTaskStatus(t1, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(t1, runId);
      store.completeTask(t1, runId, "failed", undefined, "permanent error");

      await dispatcher.handleTaskCompletion(t1);

      expect(onManagerWake).toHaveBeenCalledTimes(1);
      expect(onManagerWake).toHaveBeenCalledWith(
        objId,
        "task_failed",
        expect.stringContaining("Fatal"),
      );
    });

    it("wakes manager on objective completion", async () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "Only task" });
      store.updateTaskStatus(t1, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(t1, runId);
      store.completeTask(t1, runId, "completed");

      await dispatcher.handleTaskCompletion(t1);

      expect(onManagerWake).toHaveBeenCalledWith(
        objId,
        "objective_completed",
        expect.stringContaining("All tasks finished"),
      );
    });

    it("wakes manager on group completion", async () => {
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
      // Also add a non-group task so objective isn't complete
      store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Downstream",
      });

      // Complete both group tasks
      store.updateTaskStatus(t1, "ready");
      let runId = crypto.randomUUID();
      store.claimTask(t1, runId);
      store.completeTask(t1, runId, "completed");
      await dispatcher.handleTaskCompletion(t1);

      store.updateTaskStatus(t2, "ready");
      runId = crypto.randomUUID();
      store.claimTask(t2, runId);
      store.completeTask(t2, runId, "completed");
      await dispatcher.handleTaskCompletion(t2);

      // Manager should be woken for group completion
      expect(onManagerWake).toHaveBeenCalledWith(
        objId,
        "group_completed",
        expect.stringContaining('Group "research" complete'),
      );
    });
  });

  describe("stuck task sweep", () => {
    it("fails stuck tasks", async () => {
      dispatcher.stop();
      dispatcher = new TaskDispatcher(store, {
        tickIntervalMs: 100_000,
        maxConcurrent: 3,
        taskTimeoutMs: 0, // 0ms timeout = everything is stuck
        stuckSweepEveryNTicks: 1,
        spawnWorker,
        onManagerWake,
      });

      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "Stuck" });
      store.updateTaskStatus(t1, "ready");
      store.claimTask(t1, "stuck-run");

      dispatcher.start();
      await new Promise((r) => setTimeout(r, 50));

      const task = store.getTask(t1)!;
      expect(task.status).toBe("failed");
      expect(task.error).toContain("timeout");
    });
  });
});
