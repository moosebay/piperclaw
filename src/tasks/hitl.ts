import { emitEvent } from "./events.js";
import type { TaskStore } from "./store.js";

/**
 * Approve a waiting task by emitting an "hitl.approve" event.
 * The event bus will match this to any task waiting for "hitl.approve"
 * with a matching taskId filter.
 */
export function approveTask(
  store: TaskStore,
  taskId: string,
  approver?: string,
  comment?: string,
): { matched: boolean; waitConditionId?: string } {
  const result = emitEvent(store, "hitl.approve", { taskId, approver, comment });
  return { matched: result.matched, waitConditionId: result.waitConditionId };
}

/**
 * Reject a waiting task by emitting an "hitl.reject" event.
 */
export function rejectTask(
  store: TaskStore,
  taskId: string,
  approver?: string,
  reason?: string,
): { matched: boolean; waitConditionId?: string } {
  const result = emitEvent(store, "hitl.reject", { taskId, approver, reason });
  return { matched: result.matched, waitConditionId: result.waitConditionId };
}
