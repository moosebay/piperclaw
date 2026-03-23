/**
 * Task system plugin hook types and registration data.
 *
 * Centralizes all task-related hook names, event types, and handler map
 * entries so the host `plugins/types.ts` and `plugins/hooks.ts` only need
 * single-line spreads.
 */

// ---------------------------------------------------------------------------
// Hook names
// ---------------------------------------------------------------------------

export const TASK_HOOK_NAMES = [
  "task_ready",
  "task_completed",
  "task_failed",
  "task_waiting",
  "task_resumed",
  "objective_completed",
] as const;

export type TaskHookName = (typeof TASK_HOOK_NAMES)[number];

// ---------------------------------------------------------------------------
// Event / context types
// ---------------------------------------------------------------------------

/** Context shared across all task hooks. */
export type PluginHookTaskContext = {
  agentId: string;
  objectiveId: string;
};

/** task_ready hook */
export type PluginHookTaskReadyEvent = {
  taskId: string;
  title: string;
  assignedSkill?: string;
  group?: string;
};

/** task_completed hook */
export type PluginHookTaskCompletedEvent = {
  taskId: string;
  title: string;
  reportId?: string;
};

/** task_failed hook */
export type PluginHookTaskFailedEvent = {
  taskId: string;
  title: string;
  error?: string;
  retryCount: number;
  maxRetries: number;
  retriesExhausted: boolean;
};

/** task_waiting hook — fired when a task suspends to wait for an external event */
export type PluginHookTaskWaitingEvent = {
  taskId: string;
  title: string;
  eventName: string;
  timeoutAt?: number;
};

/** task_resumed hook — fired when a waiting task is resumed by an event */
export type PluginHookTaskResumedEvent = {
  taskId: string;
  title: string;
  eventName: string;
  eventData?: unknown;
};

/** objective_completed hook */
export type PluginHookObjectiveCompletedEvent = {
  objectiveId: string;
  title: string;
  completedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
};

// ---------------------------------------------------------------------------
// Handler map fragment  (merged into PluginHookHandlerMap in plugins/types.ts)
// ---------------------------------------------------------------------------

export type TaskHookHandlerMap = {
  task_ready: (event: PluginHookTaskReadyEvent, ctx: PluginHookTaskContext) => Promise<void> | void;
  task_completed: (
    event: PluginHookTaskCompletedEvent,
    ctx: PluginHookTaskContext,
  ) => Promise<void> | void;
  task_failed: (
    event: PluginHookTaskFailedEvent,
    ctx: PluginHookTaskContext,
  ) => Promise<void> | void;
  task_waiting: (
    event: PluginHookTaskWaitingEvent,
    ctx: PluginHookTaskContext,
  ) => Promise<void> | void;
  task_resumed: (
    event: PluginHookTaskResumedEvent,
    ctx: PluginHookTaskContext,
  ) => Promise<void> | void;
  objective_completed: (
    event: PluginHookObjectiveCompletedEvent,
    ctx: PluginHookTaskContext,
  ) => Promise<void> | void;
};
