import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDispatcher, type DispatcherConfig } from "./dispatcher.js";
import {
  formatApprovalRequest,
  formatObjectiveCompleted,
  formatTaskFailed,
  resolveNotificationConfig,
} from "./notifications.js";
import { TaskStore } from "./store.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-notify-test-"));
  return path.join(dir, "tasks.sqlite");
}

// ---------------------------------------------------------------------------
// resolveNotificationConfig
// ---------------------------------------------------------------------------

describe("resolveNotificationConfig", () => {
  it("returns config when metadata has valid notifyChannel and notifyTo", () => {
    const result = resolveNotificationConfig({
      notifyChannel: "telegram",
      notifyTo: "12345",
    });
    expect(result).toEqual({ channel: "telegram", to: "12345", accountId: undefined });
  });

  it("returns config with accountId when present", () => {
    const result = resolveNotificationConfig({
      notifyChannel: "whatsapp",
      notifyTo: "+15551234567",
      notifyAccountId: "acc-1",
    });
    expect(result).toEqual({
      channel: "whatsapp",
      to: "+15551234567",
      accountId: "acc-1",
    });
  });

  it("returns null when metadata is undefined", () => {
    expect(resolveNotificationConfig(undefined)).toBeNull();
  });

  it("returns null when notifyChannel is missing", () => {
    expect(resolveNotificationConfig({ notifyTo: "123" })).toBeNull();
  });

  it("returns null when notifyTo is missing", () => {
    expect(resolveNotificationConfig({ notifyChannel: "telegram" })).toBeNull();
  });

  it("returns null when notifyChannel is not a string", () => {
    expect(resolveNotificationConfig({ notifyChannel: 42, notifyTo: "123" })).toBeNull();
  });

  it("returns null when notifyTo is not a string", () => {
    expect(resolveNotificationConfig({ notifyChannel: "telegram", notifyTo: true })).toBeNull();
  });

  it("returns null when notifyChannel is empty string", () => {
    expect(resolveNotificationConfig({ notifyChannel: "", notifyTo: "123" })).toBeNull();
  });

  it("returns null when notifyTo is whitespace-only", () => {
    expect(resolveNotificationConfig({ notifyChannel: "telegram", notifyTo: "  " })).toBeNull();
  });

  it("trims whitespace from channel and to", () => {
    const result = resolveNotificationConfig({
      notifyChannel: " telegram ",
      notifyTo: " 12345 ",
    });
    expect(result).toEqual({ channel: "telegram", to: "12345", accountId: undefined });
  });

  it("ignores non-string notifyAccountId", () => {
    const result = resolveNotificationConfig({
      notifyChannel: "telegram",
      notifyTo: "123",
      notifyAccountId: 42,
    });
    expect(result).toEqual({ channel: "telegram", to: "123", accountId: undefined });
  });
});

// ---------------------------------------------------------------------------
// Text formatters
// ---------------------------------------------------------------------------

describe("formatObjectiveCompleted", () => {
  it("formats completed objective message", () => {
    const text = formatObjectiveCompleted("Deploy v2", 5, 5);
    expect(text).toBe('Objective complete: "Deploy v2" -- 5/5 tasks done');
  });

  it("includes partial progress", () => {
    const text = formatObjectiveCompleted("Migration", 3, 5);
    expect(text).toContain("3/5");
  });
});

describe("formatTaskFailed", () => {
  it("formats failure without error", () => {
    const text = formatTaskFailed("Run tests");
    expect(text).toBe('Task failed (retries exhausted): "Run tests"');
  });

  it("formats failure with error message", () => {
    const text = formatTaskFailed("Run tests", "timeout exceeded");
    expect(text).toBe('Task failed (retries exhausted): "Run tests" -- timeout exceeded');
  });
});

describe("formatApprovalRequest", () => {
  it("formats approval request with task ID", () => {
    const text = formatApprovalRequest("Deploy to prod", "task-abc-123");
    expect(text).toContain('"Deploy to prod"');
    expect(text).toContain("task-abc-123");
    expect(text).toContain("openclaw tasks approve task-abc-123");
  });
});

// ---------------------------------------------------------------------------
// Dispatcher notification integration
// ---------------------------------------------------------------------------

describe("Dispatcher onNotify integration", () => {
  type SpawnWorkerFn = DispatcherConfig["spawnWorker"];
  type OnManagerWakeFn = DispatcherConfig["onManagerWake"];
  type OnNotifyFn = NonNullable<DispatcherConfig["onNotify"]>;

  let store: TaskStore;
  let spawnWorker: SpawnWorkerFn;
  let onManagerWake: OnManagerWakeFn;
  let onNotify: OnNotifyFn;
  let dispatcher: TaskDispatcher;
  let objId: string;

  beforeEach(() => {
    store = new TaskStore(tmpDb());
    spawnWorker = vi.fn<SpawnWorkerFn>().mockResolvedValue("mock-run-id");
    onManagerWake = vi.fn<OnManagerWakeFn>().mockResolvedValue(undefined);
    onNotify = vi.fn<OnNotifyFn>().mockResolvedValue(undefined);
    dispatcher = new TaskDispatcher(store, {
      tickIntervalMs: 100_000,
      maxConcurrent: 3,
      taskTimeoutMs: 60_000,
      spawnWorker,
      onManagerWake,
      onNotify,
    });
    objId = store.createObjective({
      agentId: "main",
      title: "Test Objective",
      description: "test",
      metadata: { notifyChannel: "telegram", notifyTo: "chat-42" },
    });
  });

  afterEach(() => {
    dispatcher.stop();
    store.close();
  });

  it("sends notification on objective completion", async () => {
    const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "Only task" });
    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "completed");

    await dispatcher.handleTaskCompletion(t1);

    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining("Objective complete"),
      expect.objectContaining({ notifyChannel: "telegram", notifyTo: "chat-42" }),
    );
  });

  it("sends notification on task failure with retries exhausted", async () => {
    const t1 = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "Failing task",
      maxRetries: 0,
    });
    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "failed", undefined, "permanent error");

    await dispatcher.handleTaskCompletion(t1);

    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining("Task failed"),
      expect.objectContaining({ notifyChannel: "telegram", notifyTo: "chat-42" }),
    );
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining("permanent error"),
      expect.anything(),
    );
  });

  it("does not notify on task failure when retries remain", async () => {
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

    // onNotify should not be called for retryable failures
    expect(onNotify).not.toHaveBeenCalled();
  });

  it("does not notify when onNotify is not configured", async () => {
    // Create a dispatcher without onNotify
    dispatcher.stop();
    const noNotifyDispatcher = new TaskDispatcher(store, {
      tickIntervalMs: 100_000,
      maxConcurrent: 3,
      taskTimeoutMs: 60_000,
      spawnWorker,
      onManagerWake,
    });

    const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "Solo" });
    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "completed");

    // Should not throw even without onNotify
    await noNotifyDispatcher.handleTaskCompletion(t1);
    noNotifyDispatcher.stop();
  });

  it("sends only task-failed notification when sole task fails (wake reason is task_failed, not objective_completed)", async () => {
    // When a single task fails with no retries, shouldWakeManager returns
    // "task_failed" (the most specific reason), not "objective_completed".
    // So only the task-failed notification fires, not objective-completed.
    const t1 = store.createTask({
      agentId: "main",
      objectiveId: objId,
      title: "The only task",
      maxRetries: 0,
    });
    store.updateTaskStatus(t1, "ready");
    const runId = crypto.randomUUID();
    store.claimTask(t1, runId);
    store.completeTask(t1, runId, "failed", undefined, "boom");

    await dispatcher.handleTaskCompletion(t1);

    const calls = (onNotify as ReturnType<typeof vi.fn>).mock.calls;
    const texts = calls.map((c: unknown[]) => c[0] as string);
    expect(texts.some((t: string) => t.includes("Task failed"))).toBe(true);
    // objective_completed is not emitted because shouldWakeManager returns
    // task_failed first for a failed task with retries exhausted.
    expect(texts.some((t: string) => t.includes("Objective complete"))).toBe(false);
  });
});
