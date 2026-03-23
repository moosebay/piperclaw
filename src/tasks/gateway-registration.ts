/**
 * Task system registration data for the gateway layer.
 *
 * Centralizes all task-system method scopes and broadcast events so that the
 * host gateway files only need a single-line spread.  This keeps rebase
 * friction near zero when upstream changes method-scopes, server-broadcast, or
 * server-close.
 */

// ---------------------------------------------------------------------------
// Method scopes  (consumed by method-scopes.ts)
// ---------------------------------------------------------------------------

/** Task RPC methods that require the `operator.read` scope. */
export const TASK_READ_METHODS = [
  "tasks.objectives.list",
  "tasks.objectives.get",
  "tasks.list",
  "tasks.get",
  "tasks.reports.list",
  "tasks.reports.get",
  "tasks.steps.list",
  "tasks.audit.list",
  "tasks.skills.list",
] as const;

/** Task RPC methods that require the `operator.write` scope. */
export const TASK_WRITE_METHODS = ["tasks.approve", "tasks.reject", "tasks.events.emit"] as const;

// ---------------------------------------------------------------------------
// Broadcast event scope guards  (consumed by server-broadcast.ts)
// ---------------------------------------------------------------------------

/** Broadcast event → required scopes for task-related events. */
export const TASK_EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  "task.status": ["operator.read"],
  "objective.progress": ["operator.read"],
};

// ---------------------------------------------------------------------------
// Gateway close  (consumed by server-close.ts)
// ---------------------------------------------------------------------------

export type TaskServiceHandle = { stop: () => void };
