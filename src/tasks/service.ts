import { spawnSubagentDirect } from "../agents/subagent-spawn.js";
import { TaskDispatcher } from "./dispatcher.js";
import { taskLog as log } from "./log.js";
import { buildWorkerPrompt } from "./reports.js";
import { TaskStore } from "./store.js";
import type { TaskRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type TaskServiceConfig = {
  /** Path to SQLite database. Defaults to ~/.openclaw/state/tasks.sqlite */
  dbPath?: string;
  /** Max concurrent running tasks (default 3). */
  maxConcurrent?: number;
  /** Dispatcher tick interval in ms (default 5000). */
  tickIntervalMs?: number;
  /** Stuck task timeout in ms (default 30 min). */
  taskTimeoutMs?: number;
  /** Callback to spawn a worker sub-agent. Returns runId or undefined. */
  spawnWorker?: (task: TaskRecord, depReportSummaries: string[]) => Promise<string | undefined>;
  /** Callback to re-invoke the manager with context. */
  onManagerWake?: (objectiveId: string, reason: string, context: string) => Promise<void>;
};

// ---------------------------------------------------------------------------
// TaskService — instantiable, testable
// ---------------------------------------------------------------------------

export class TaskService {
  readonly store: TaskStore;
  readonly dispatcher: TaskDispatcher;

  constructor(config: TaskServiceConfig = {}) {
    // 1. Open DB
    this.store = new TaskStore(config.dbPath);

    // 2. Startup recovery — fail orphaned running tasks
    recoverOrphanedTasks(this.store);

    // 3. Create dispatcher with callbacks
    const spawnWorker =
      config.spawnWorker ??
      (async (task: TaskRecord, depSummaries: string[]) => {
        const prompt = buildWorkerPrompt(task, depSummaries);
        const result = await spawnSubagentDirect(
          {
            task: prompt,
            label: `task:${task.id}`,
            agentId: task.assignedAgentId ?? task.agentId,
            mode: "run",
            cleanup: "delete",
            runTimeoutSeconds: (task.metadata?.timeoutSeconds as number) ?? 600,
            expectsCompletionMessage: false,
          },
          { requesterAgentIdOverride: task.agentId },
        );
        if (result.status !== "accepted") {
          throw new Error(result.error ?? "spawn rejected");
        }
        return result.runId;
      });

    const onManagerWake =
      config.onManagerWake ??
      (async (objectiveId: string, reason: string, context: string) => {
        const result = await spawnSubagentDirect(
          {
            task: context,
            label: `manager:${objectiveId}:${reason}`,
            agentId: "main",
            mode: "run",
            cleanup: "delete",
            runTimeoutSeconds: 300,
            expectsCompletionMessage: false,
          },
          { requesterAgentIdOverride: "main" },
        );
        if (result.status !== "accepted") {
          log.error(`Manager spawn failed for ${objectiveId}: ${result.error}`);
        }
      });

    this.dispatcher = new TaskDispatcher(this.store, {
      maxConcurrent: config.maxConcurrent,
      tickIntervalMs: config.tickIntervalMs,
      taskTimeoutMs: config.taskTimeoutMs,
      spawnWorker,
      onManagerWake,
    });
  }

  start(): void {
    this.dispatcher.start();
    log.info("Task service started");
  }

  stop(): void {
    this.dispatcher.stop();
    this.store.close();
    log.info("Task service stopped");
  }

  nudge(): void {
    this.dispatcher.nudge();
  }

  async notifyTaskCompletion(
    taskId: string,
    runId: string,
    status: "completed" | "failed",
    result?: unknown,
    error?: string,
  ): Promise<void> {
    const completed = this.store.completeTask(taskId, runId, status, result, error);
    if (!completed) {
      return;
    } // stale completion
    await this.dispatcher.handleTaskCompletion(taskId);
  }
}

// ---------------------------------------------------------------------------
// Default singleton for production use
// ---------------------------------------------------------------------------

let defaultService: TaskService | null = null;

export function startTaskService(config: TaskServiceConfig = {}): TaskService {
  if (defaultService) {
    log.info("Task service already running, returning existing instance");
    return defaultService;
  }
  defaultService = new TaskService(config);
  defaultService.start();
  return defaultService;
}

export function stopTaskService(): void {
  if (!defaultService) {
    return;
  }
  defaultService.stop();
  defaultService = null;
}

/** Get the default singleton store (for tools/CLI). */
export function getTaskStore(): TaskStore | null {
  return defaultService?.store ?? null;
}

/** Get the default singleton dispatcher. */
export function getTaskDispatcher(): TaskDispatcher | null {
  return defaultService?.dispatcher ?? null;
}

/** Nudge the default singleton dispatcher. */
export function nudgeDispatcher(): void {
  defaultService?.nudge();
}

/**
 * Called from subagent_ended hook. Looks up a running task by its subagent
 * runId and completes it based on the subagent outcome.
 */
export async function notifyTaskCompletionFromSubagent(
  runId: string,
  outcome: string | undefined,
  error: string | undefined,
  frozenResultText?: string,
): Promise<void> {
  if (!defaultService) {
    return;
  }
  const { store, dispatcher } = defaultService;

  const task = store.getTaskByRunId(runId);
  if (!task) {
    return;
  } // Not a task-managed subagent

  const status = outcome === "ok" ? "completed" : "failed";
  const errorMsg = status === "failed" ? (error ?? `subagent ended: ${outcome}`) : undefined;

  const completed = store.completeTask(task.id, runId, status, undefined, errorMsg);
  if (!completed) {
    return;
  } // Stale — already handled

  // Fallback report capture: if worker completed without calling the report
  // tool and frozenResultText is available, auto-create a report so output
  // is not lost.
  if (status === "completed" && frozenResultText?.trim()) {
    const existing = store.getReportByTask(task.id);
    if (!existing) {
      try {
        store.createReport({
          taskId: task.id,
          title: `Auto-captured: ${task.title}`,
          summary: frozenResultText.trim().slice(0, 300),
          content: frozenResultText,
          format: "markdown",
          metadata: { source: "fallback-capture" },
        });
      } catch {
        log.warn(`Failed to create fallback report for task ${task.id}`);
      }
    }
  }

  await dispatcher.handleTaskCompletion(task.id);
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

function recoverOrphanedTasks(taskStore: TaskStore): void {
  const stuck = taskStore.listTasks({ status: "running" });
  if (stuck.length === 0) {
    return;
  }

  log.warn(`Recovering ${stuck.length} orphaned running tasks`);
  for (const task of stuck) {
    if (task.runId) {
      taskStore.completeTask(
        task.id,
        task.runId,
        "failed",
        undefined,
        "orphaned: subagent not found after restart",
      );
    }
  }
}
