import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "./store.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-store-test-"));
  return path.join(dir, "tasks.sqlite");
}

describe("TaskStore", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(tmpDb());
  });

  afterEach(() => {
    store.close();
  });

  // -----------------------------------------------------------------------
  // Objectives
  // -----------------------------------------------------------------------

  describe("objectives", () => {
    it("creates and retrieves an objective", () => {
      const id = store.createObjective({
        agentId: "main",
        title: "Test Objective",
        description: "Done when tests pass",
      });
      expect(id).toBeTruthy();

      const obj = store.getObjective(id);
      expect(obj).toBeDefined();
      expect(obj!.title).toBe("Test Objective");
      expect(obj!.status).toBe("active");
      expect(obj!.proposedBy).toBe("user");
    });

    it("lists objectives with filters", () => {
      store.createObjective({ agentId: "main", title: "A", description: "a" });
      store.createObjective({ agentId: "other", title: "B", description: "b" });

      const all = store.listObjectives();
      expect(all.length).toBe(2);

      const mainOnly = store.listObjectives({ agentId: "main" });
      expect(mainOnly.length).toBe(1);
      expect(mainOnly[0].title).toBe("A");
    });

    it("updates status and marks completed", () => {
      const id = store.createObjective({
        agentId: "main",
        title: "X",
        description: "x",
      });
      store.updateObjectiveStatus(id, "paused");
      expect(store.getObjective(id)!.status).toBe("paused");

      store.markObjectiveCompleted(id);
      const obj = store.getObjective(id)!;
      expect(obj.status).toBe("completed");
      expect(obj.completedAt).toBeDefined();
    });

    it("calculates objective progress", () => {
      const objId = store.createObjective({
        agentId: "main",
        title: "Progress Test",
        description: "test",
      });
      store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      store.createTask({ agentId: "main", objectiveId: objId, title: "T3" });

      const progress = store.getObjectiveProgress(objId);
      expect(progress.total).toBe(3);
      expect(progress.pending).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Tasks
  // -----------------------------------------------------------------------

  describe("tasks", () => {
    let objId: string;

    beforeEach(() => {
      objId = store.createObjective({
        agentId: "main",
        title: "Test",
        description: "test",
      });
    });

    it("creates a task with default values", () => {
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Do something",
      });
      const task = store.getTask(id);
      expect(task).toBeDefined();
      expect(task!.status).toBe("pending");
      expect(task!.managerTrigger).toBe("none");
      expect(task!.maxRetries).toBe(0);
      expect(task!.retryCount).toBe(0);
    });

    it("creates scheduled task in scheduled status", () => {
      const futureTime = Date.now() + 60_000;
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Scheduled",
        scheduledAt: futureTime,
      });
      expect(store.getTask(id)!.status).toBe("scheduled");
    });

    it("lists tasks with filters", () => {
      store.createTask({ agentId: "main", objectiveId: objId, title: "A", group: "g1" });
      store.createTask({ agentId: "main", objectiveId: objId, title: "B", group: "g2" });

      const byGroup = store.listTasks({ group: "g1" });
      expect(byGroup.length).toBe(1);
      expect(byGroup[0].title).toBe("A");
    });

    it("enforces legal state transitions", () => {
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "T",
      });

      // pending → ready is legal
      store.updateTaskStatus(id, "ready");
      expect(store.getTask(id)!.status).toBe("ready");

      // ready → completed is NOT legal (must go through running)
      expect(() => store.updateTaskStatus(id, "completed")).toThrow("Illegal transition");
    });

    it("rejects illegal transitions", () => {
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "T",
      });
      // pending → running is illegal
      expect(() => store.updateTaskStatus(id, "running")).toThrow("Illegal transition");
    });
  });

  // -----------------------------------------------------------------------
  // Atomic claiming
  // -----------------------------------------------------------------------

  describe("claimTask", () => {
    let objId: string;

    beforeEach(() => {
      objId = store.createObjective({
        agentId: "main",
        title: "Test",
        description: "test",
      });
    });

    it("claims a ready task atomically", () => {
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Claimable",
      });
      store.updateTaskStatus(id, "ready");

      const runId = crypto.randomUUID();
      const claimed = store.claimTask(id, runId);
      expect(claimed).toBe(true);

      const task = store.getTask(id);
      expect(task!.status).toBe("running");
      expect(task!.runId).toBe(runId);
    });

    it("prevents double-claim", () => {
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Claimable",
      });
      store.updateTaskStatus(id, "ready");

      const claimed1 = store.claimTask(id, crypto.randomUUID());
      const claimed2 = store.claimTask(id, crypto.randomUUID());

      expect(claimed1).toBe(true);
      expect(claimed2).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Idempotent completion
  // -----------------------------------------------------------------------

  describe("completeTask", () => {
    let objId: string;

    beforeEach(() => {
      objId = store.createObjective({
        agentId: "main",
        title: "Test",
        description: "test",
      });
    });

    it("completes a running task with matching runId", () => {
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Complete me",
      });
      store.updateTaskStatus(id, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(id, runId);

      const completed = store.completeTask(id, runId, "completed", { data: "ok" });
      expect(completed).toBe(true);

      const task = store.getTask(id)!;
      expect(task.status).toBe("completed");
      expect(task.result).toEqual({ data: "ok" });
    });

    it("rejects stale completion (wrong runId)", () => {
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Complete me",
      });
      store.updateTaskStatus(id, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(id, runId);

      const staleComplete = store.completeTask(id, "wrong-run-id", "completed");
      expect(staleComplete).toBe(false);
      expect(store.getTask(id)!.status).toBe("running");
    });

    it("handles failure completion", () => {
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Fail me",
      });
      store.updateTaskStatus(id, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(id, runId);

      const completed = store.completeTask(id, runId, "failed", undefined, "boom");
      expect(completed).toBe(true);

      const task = store.getTask(id)!;
      expect(task.status).toBe("failed");
      expect(task.error).toBe("boom");
    });
  });

  // -----------------------------------------------------------------------
  // Retry
  // -----------------------------------------------------------------------

  describe("retryTask", () => {
    let objId: string;

    beforeEach(() => {
      objId = store.createObjective({
        agentId: "main",
        title: "Test",
        description: "test",
      });
    });

    it("retries a failed task with exponential backoff", () => {
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Retryable",
        maxRetries: 3,
        retryAfterMs: 1000,
      });
      store.updateTaskStatus(id, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(id, runId);
      store.completeTask(id, runId, "failed", undefined, "transient error");

      store.retryTask(id);

      const task = store.getTask(id)!;
      expect(task.status).toBe("pending");
      expect(task.retryCount).toBe(1);
      expect(task.scheduledAt).toBeDefined();
      // First retry: 1000 * 2^0 = 1000ms delay
      expect(task.scheduledAt!).toBeGreaterThan(Date.now() - 100);
    });

    it("throws when retries exhausted", () => {
      const id = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "No more retries",
        maxRetries: 0,
      });
      store.updateTaskStatus(id, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(id, runId);
      store.completeTask(id, runId, "failed", undefined, "error");

      expect(() => store.retryTask(id)).toThrow("exhausted retries");
    });
  });

  // -----------------------------------------------------------------------
  // Dependencies
  // -----------------------------------------------------------------------

  describe("dependencies", () => {
    let objId: string;

    beforeEach(() => {
      objId = store.createObjective({
        agentId: "main",
        title: "Test",
        description: "test",
      });
    });

    it("adds and queries dependencies", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      store.addDependency(t2, t1);

      expect(store.getDependencies(t2)).toEqual([t1]);
      expect(store.getDependents(t1)).toEqual([t2]);
    });

    it("checks if all deps are completed", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      store.addDependency(t2, t1);

      expect(store.allDepsCompleted(t2)).toBe(false);

      // Complete t1
      store.updateTaskStatus(t1, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(t1, runId);
      store.completeTask(t1, runId, "completed");

      expect(store.allDepsCompleted(t2)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Ready task promotion
  // -----------------------------------------------------------------------

  describe("getReadyTasks", () => {
    let objId: string;

    beforeEach(() => {
      objId = store.createObjective({
        agentId: "main",
        title: "Test",
        description: "test",
      });
    });

    it("promotes pending tasks with no deps to ready", () => {
      store.createTask({ agentId: "main", objectiveId: objId, title: "No deps" });

      const ready = store.getReadyTasks();
      expect(ready.length).toBe(1);
      expect(ready[0].title).toBe("No deps");
      expect(ready[0].status).toBe("ready");
    });

    it("does not promote tasks with unresolved deps", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      store.addDependency(t2, t1);

      const ready = store.getReadyTasks();
      // T1 should be ready, T2 should still be pending
      expect(ready.length).toBe(1);
      expect(ready[0].title).toBe("T1");
    });
  });

  // -----------------------------------------------------------------------
  // Stuck tasks
  // -----------------------------------------------------------------------

  describe("getStuckTasks", () => {
    let objId: string;

    beforeEach(() => {
      objId = store.createObjective({
        agentId: "main",
        title: "Test",
        description: "test",
      });
    });

    it("finds tasks running longer than timeout", () => {
      const id = store.createTask({ agentId: "main", objectiveId: objId, title: "Stuck" });
      store.updateTaskStatus(id, "ready");
      store.claimTask(id, "run-1");

      // With 0ms timeout: cutoff = Date.now(), started_at <= cutoff → detected as stuck
      const stuck = store.getStuckTasks(0);
      expect(stuck.length).toBe(1);
      expect(stuck[0].id).toBe(id);

      // With a very large timeout: cutoff is far in the past → not stuck
      expect(store.getStuckTasks(999_999).length).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Reports
  // -----------------------------------------------------------------------

  describe("reports", () => {
    let objId: string;
    let taskId: string;

    beforeEach(() => {
      objId = store.createObjective({
        agentId: "main",
        title: "Test",
        description: "test",
      });
      taskId = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Task with report",
      });
    });

    it("creates and retrieves a report", () => {
      const reportId = store.createReport({
        taskId,
        title: "Research Report",
        summary: "Found 10 companies",
        content: "# Full report\n\nDetailed analysis...",
      });

      const report = store.getReport(reportId);
      expect(report).toBeDefined();
      expect(report!.title).toBe("Research Report");
      expect(report!.summary).toBe("Found 10 companies");
      expect(report!.objectiveId).toBe(objId);
    });

    it("links report to task", () => {
      const reportId = store.createReport({
        taskId,
        title: "Report",
        summary: "Summary",
        content: "Content",
      });
      store.linkReportToTask(reportId, taskId);

      const task = store.getTask(taskId);
      expect(task!.reportId).toBe(reportId);
    });

    it("retrieves report by task", () => {
      store.createReport({
        taskId,
        title: "By Task",
        summary: "S",
        content: "C",
      });

      const report = store.getReportByTask(taskId);
      expect(report).toBeDefined();
      expect(report!.title).toBe("By Task");
    });

    it("lists reports by objective", () => {
      const t2 = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "Task 2",
      });
      store.createReport({ taskId, title: "R1", summary: "S1", content: "C1" });
      store.createReport({ taskId: t2, title: "R2", summary: "S2", content: "C2" });

      const reports = store.getReportsByObjective(objId);
      expect(reports.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Group queries
  // -----------------------------------------------------------------------

  describe("groups", () => {
    it("retrieves tasks by group", () => {
      const objId = store.createObjective({
        agentId: "main",
        title: "G",
        description: "g",
      });
      store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "A",
        group: "research",
      });
      store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "B",
        group: "research",
      });
      store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "C",
        group: "draft",
      });

      const research = store.getTasksByGroup("research");
      expect(research.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Concurrency
  // -----------------------------------------------------------------------

  describe("countRunningTasks", () => {
    it("counts running tasks globally and per-agent", () => {
      const objId = store.createObjective({
        agentId: "main",
        title: "C",
        description: "c",
      });
      const id1 = store.createTask({ agentId: "main", objectiveId: objId, title: "R1" });
      const id2 = store.createTask({ agentId: "other", objectiveId: objId, title: "R2" });

      store.updateTaskStatus(id1, "ready");
      store.updateTaskStatus(id2, "ready");
      store.claimTask(id1, "run-1");
      store.claimTask(id2, "run-2");

      expect(store.countRunningTasks()).toBe(2);
      expect(store.countRunningTasks("main")).toBe(1);
      expect(store.countRunningTasks("other")).toBe(1);
    });
  });
});
