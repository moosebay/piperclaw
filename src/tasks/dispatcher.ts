import crypto from "node:crypto";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { resolveDependents } from "./deps.js";
import { taskLog as log } from "./log.js";
import { shouldWakeManager } from "./manager-callback.js";
import { buildManagerContext } from "./reports.js";
import type { TaskStore } from "./store.js";
import type { TaskRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type DispatcherConfig = {
  /** Tick interval in ms (default 5000). */
  tickIntervalMs: number;
  /** Max concurrent running tasks globally (default 3). */
  maxConcurrent: number;
  /** Stuck task timeout in ms (default 30 min). */
  taskTimeoutMs: number;
  /** How often to run stuck task sweep, in ticks (default 12 = every 60s at 5s tick). */
  stuckSweepEveryNTicks: number;
  /** Callback to spawn a worker sub-agent for a task. */
  spawnWorker: (task: TaskRecord, depReportSummaries: string[]) => Promise<string | undefined>;
  /** Callback to re-invoke the manager with context. */
  onManagerWake: (objectiveId: string, reason: string, context: string) => Promise<void>;
};

const DEFAULT_CONFIG: Omit<DispatcherConfig, "spawnWorker" | "onManagerWake"> = {
  tickIntervalMs: 5000,
  maxConcurrent: 3,
  taskTimeoutMs: 30 * 60 * 1000,
  stuckSweepEveryNTicks: 12,
};

// ---------------------------------------------------------------------------
// TaskDispatcher
// ---------------------------------------------------------------------------

export class TaskDispatcher {
  private store: TaskStore;
  private config: DispatcherConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private running = false;
  private tickInProgress = false;
  private nudgePending = false;
  /** In-memory tracking for inter-task delay enforcement. */
  private lastDispatchByObjective = new Map<string, number>();

  constructor(
    store: TaskStore,
    config: Partial<DispatcherConfig> & Pick<DispatcherConfig, "spawnWorker" | "onManagerWake">,
  ) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.scheduleTick();
    }, this.config.tickIntervalMs);
    // Run first tick immediately
    void this.scheduleTick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Immediate re-check — called after task create/complete. */
  nudge(): void {
    if (!this.running) {
      return;
    }
    void this.scheduleTick();
  }

  // -------------------------------------------------------------------------
  // Reentrancy guard
  // -------------------------------------------------------------------------

  private async scheduleTick(): Promise<void> {
    if (this.tickInProgress) {
      // Mark that a nudge arrived during execution — we'll re-tick when done
      this.nudgePending = true;
      return;
    }
    this.tickInProgress = true;
    try {
      await this.tick();
    } finally {
      this.tickInProgress = false;
      // If a nudge arrived while we were ticking, run one more tick
      if (this.nudgePending && this.running) {
        this.nudgePending = false;
        void this.scheduleTick();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Core dispatch loop
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    try {
      this.tickCount++;

      // Stuck task sweep + expired wait conditions every N ticks
      if (this.tickCount % this.config.stuckSweepEveryNTicks === 0) {
        await this.sweepStuckTasks();
        await this.sweepExpiredWaits();
      }

      // Get ready tasks (pure query — no side-effecting promotion)
      const readyTasks = this.store.getReadyTasks();
      if (readyTasks.length === 0) {
        return;
      }

      // Check concurrency
      const currentRunning = this.store.countRunningTasks();
      let slots = this.config.maxConcurrent - currentRunning;
      if (slots <= 0) {
        return;
      }

      // Cache objectives per tick to avoid repeated queries
      const objectiveCache = new Map<string, import("./types.js").ObjectiveRecord | undefined>();
      const getObjective = (id: string) => {
        if (!objectiveCache.has(id)) {
          objectiveCache.set(id, this.store.getObjective(id));
        }
        return objectiveCache.get(id);
      };

      // Dispatch ready tasks up to concurrency limit
      const now = Date.now();
      const spawnPromises: Promise<void>[] = [];
      for (const task of readyTasks) {
        if (slots <= 0) {
          break;
        }

        const objective = getObjective(task.objectiveId);

        // Rate limit check: skip if objective has hit its window cap
        if (objective?.rateLimit) {
          const { maxPerWindow, windowMs } = objective.rateLimit;
          const recent = this.store.countRecentCompletions(task.objectiveId, windowMs);
          if (recent >= maxPerWindow) {
            continue;
          }
        }

        // Inter-task delay check: skip if not enough time since last dispatch for this objective
        if (objective?.interTaskDelayMs) {
          const last = this.lastDispatchByObjective.get(task.objectiveId) ?? 0;
          if (now - last < objective.interTaskDelayMs) {
            continue;
          }
        }

        const runId = crypto.randomUUID();
        const claimed = this.store.claimTask(task.id, runId);
        if (!claimed) {
          continue;
        } // already claimed by another tick

        slots--;
        this.lastDispatchByObjective.set(task.objectiveId, now);

        // Gather dependency report summaries for worker context
        const depSummaries = this.getDepReportSummaries(task);

        // Collect spawn promises — await them all before tick ends
        spawnPromises.push(this.spawnWorkerForTask(task, runId, depSummaries));
      }

      // Await all spawns so we don't overlap with the next tick
      await Promise.allSettled(spawnPromises);
    } catch (err) {
      log.error(
        `[task-dispatcher] Tick error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }

  private async spawnWorkerForTask(
    task: TaskRecord,
    runId: string,
    depSummaries: string[],
  ): Promise<void> {
    try {
      const spawnRunId = await this.config.spawnWorker(task, depSummaries);
      // Update task's runId to match the subagent's actual runId so the
      // subagent_ended hook can look it up via getTaskByRunId.
      if (spawnRunId && spawnRunId !== runId) {
        this.store.updateRunId(task.id, runId, spawnRunId);
      }
    } catch (err) {
      log.error(`[task-dispatcher] Worker spawn failed for task ${task.id}: ${String(err)}`);
      this.store.completeTask(task.id, runId, "failed", undefined, String(err));
      await this.handleTaskCompletion(task.id);
    }
  }

  // -------------------------------------------------------------------------
  // Task completion handling
  // -------------------------------------------------------------------------

  /**
   * Called when a task finishes (completed or failed).
   * Handles: dependency resolution, retry logic, manager triggers.
   */
  async handleTaskCompletion(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task) {
      return;
    }

    const hookRunner = getGlobalHookRunner();
    const taskCtx = { agentId: task.agentId, objectiveId: task.objectiveId };

    if (task.status === "failed") {
      // Emit task_failed hook
      void hookRunner?.runTaskFailed(
        {
          taskId: task.id,
          title: task.title,
          error: task.error,
          retryCount: task.retryCount,
          maxRetries: task.maxRetries,
          retriesExhausted: task.retryCount >= task.maxRetries,
        },
        taskCtx,
      );

      // Check retry
      if (task.retryCount < task.maxRetries) {
        try {
          this.store.retryTask(taskId);
          log.info(
            `[task-dispatcher] Task ${taskId} retry ${task.retryCount + 1}/${task.maxRetries}`,
          );
          this.nudge();
          return;
        } catch (err) {
          log.error(`[task-dispatcher] Retry failed for task ${taskId}: ${String(err)}`);
        }
      }
    }

    if (task.status === "completed") {
      // Emit task_completed hook
      void hookRunner?.runTaskCompleted(
        { taskId: task.id, title: task.title, reportId: task.reportId },
        taskCtx,
      );

      // Resolve dependents
      const promoted = resolveDependents(taskId, this.store);
      if (promoted.length > 0) {
        log.info(
          `[task-dispatcher] Task ${taskId} completion promoted ${promoted.length} tasks to ready`,
        );
        // Emit task_ready for each promoted task
        for (const promotedId of promoted) {
          const promotedTask = this.store.getTask(promotedId);
          if (promotedTask) {
            void hookRunner?.runTaskReady(
              {
                taskId: promotedTask.id,
                title: promotedTask.title,
                assignedSkill: promotedTask.assignedSkill,
                group: promotedTask.group,
              },
              { agentId: promotedTask.agentId, objectiveId: promotedTask.objectiveId },
            );
          }
        }
      }
    }

    // Check manager trigger
    const wakeReason = shouldWakeManager(task, this.store);
    if (wakeReason) {
      log.info(`[task-dispatcher] Manager wake: ${wakeReason.reason} for task ${taskId}`);

      // Emit objective_completed hook
      if (wakeReason.reason === "objective_completed") {
        const progress = this.store.getObjectiveProgress(task.objectiveId);
        const objective = this.store.getObjective(task.objectiveId);
        if (objective) {
          void hookRunner?.runObjectiveCompleted(
            {
              objectiveId: objective.id,
              title: objective.title,
              completedTasks: progress.completed,
              failedTasks: progress.failed,
              cancelledTasks: progress.cancelled,
            },
            taskCtx,
          );
        }
      }

      try {
        const context = buildManagerContext(wakeReason, task.objectiveId, this.store);
        await this.config.onManagerWake(task.objectiveId, wakeReason.reason, context);
      } catch (err) {
        log.error(`[task-dispatcher] Manager re-invocation failed: ${String(err)}`);
      }
    }

    // Nudge dispatcher to pick up newly ready tasks
    this.nudge();
  }

  // -------------------------------------------------------------------------
  // Stuck task sweep
  // -------------------------------------------------------------------------

  private async sweepStuckTasks(): Promise<void> {
    const stuck = this.store.getStuckTasks(this.config.taskTimeoutMs);
    for (const task of stuck) {
      if (!task.runId) {
        continue;
      }
      const completed = this.store.completeTask(
        task.id,
        task.runId,
        "failed",
        undefined,
        `timeout: exceeded taskTimeoutMs (${this.config.taskTimeoutMs}ms)`,
      );
      if (completed) {
        log.warn(
          `[task-dispatcher] Task ${task.id} timed out after ${this.config.taskTimeoutMs}ms`,
        );
        await this.handleTaskCompletion(task.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Expired wait condition sweep
  // -------------------------------------------------------------------------

  private async sweepExpiredWaits(): Promise<void> {
    const expired = this.store.getExpiredWaitConditions();
    for (const wait of expired) {
      this.store.removeWaitCondition(wait.id);
      const task = this.store.getTask(wait.taskId);
      if (task?.status === "waiting") {
        this.store.updateTaskStatus(wait.taskId, "failed");
        log.warn(
          `[task-dispatcher] Wait condition expired for task ${wait.taskId} (event: ${wait.eventName})`,
        );
        await this.handleTaskCompletion(wait.taskId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private getDepReportSummaries(task: TaskRecord): string[] {
    const deps = task.dependsOn ?? [];
    const summaries: string[] = [];
    for (const depId of deps) {
      const report = this.store.getReportByTask(depId);
      if (report) {
        summaries.push(`[${report.title}]: ${report.summary}`);
      }
    }
    return summaries;
  }
}
