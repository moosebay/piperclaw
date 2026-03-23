import type { TaskStore } from "./store.js";
import type { TaskRecord, ManagerWakeReason } from "./types.js";

/**
 * Evaluate whether the manager should be re-invoked after a task status change.
 *
 * The manager is NOT invoked on every task completion — the dispatcher handles
 * the happy path autonomously. Manager wakes only when a decision is needed:
 *
 * 1. Task failure with retries exhausted
 * 2. Task explicitly flagged (managerTrigger: 'on_complete' | 'on_fail')
 * 3. All tasks in a group complete (fan-in gate)
 * 4. All tasks in an objective are done (objective completion)
 */
export function shouldWakeManager(task: TaskRecord, store: TaskStore): ManagerWakeReason | null {
  // 1. Failure with retries exhausted
  if (task.status === "failed" && task.retryCount >= task.maxRetries) {
    return { reason: "task_failed", taskId: task.id };
  }

  // 2. Task explicitly flagged for review
  if (task.status === "completed" && task.managerTrigger === "on_complete") {
    return { reason: "task_review", taskId: task.id };
  }
  if (task.status === "failed" && task.managerTrigger === "on_fail") {
    return { reason: "task_review", taskId: task.id };
  }

  // 3. Group/fan-in complete — all tasks in group are completed or cancelled
  if (task.group) {
    const groupTasks = store.getTasksByGroup(task.group);
    const allDone = groupTasks.every((t) => t.status === "completed" || t.status === "cancelled");
    if (allDone) {
      return { reason: "group_completed", group: task.group };
    }
  }

  // 4. Objective complete — no pending/scheduled/ready/running tasks remain
  const progress = store.getObjectiveProgress(task.objectiveId);
  if (
    progress.pending === 0 &&
    progress.running === 0 &&
    progress.ready === 0 &&
    progress.scheduled === 0 &&
    progress.waiting === 0
  ) {
    return { reason: "objective_completed", objectiveId: task.objectiveId };
  }

  // Happy path — no manager needed
  return null;
}
