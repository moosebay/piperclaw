import type { TaskStore } from "./store.js";

/**
 * Emit an event and immediately check for matching wait conditions.
 * If a match is found, consume the event and return the matched task info.
 *
 * Pull-on-emit: no polling needed. The match check happens synchronously
 * within the same SQLite transaction as the event insert.
 */
export function emitEvent(
  store: TaskStore,
  eventName: string,
  data?: unknown,
): { matched: boolean; taskId?: string; waitConditionId?: string } {
  const eventId = store.insertEvent(eventName, data);
  const match = store.findMatchingWait(eventName, data);
  if (!match) {
    return { matched: false };
  }
  store.consumeEvent(eventId, match.taskId);
  store.removeWaitCondition(match.waitCondition.id);
  return {
    matched: true,
    taskId: match.taskId,
    waitConditionId: match.waitCondition.id,
  };
}

/**
 * Register a wait condition for a task.
 * The task should already be in "waiting" status.
 */
export function registerWaitCondition(
  store: TaskStore,
  taskId: string,
  eventName: string,
  filter?: Record<string, unknown>,
  timeoutMs?: number,
): string {
  const timeoutAt = timeoutMs ? Date.now() + timeoutMs : undefined;
  return store.insertWaitCondition(taskId, eventName, filter, timeoutAt);
}
