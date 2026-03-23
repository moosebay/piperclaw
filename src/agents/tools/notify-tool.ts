import { Type } from "@sinclair/typebox";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { emitEvent } from "../../tasks/events.js";
import { getTaskStore, nudgeDispatcher, resumeTaskFromEvent } from "../../tasks/service.runtime.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const NotifyToolSchema = Type.Object(
  {
    eventName: Type.String({
      description: "Event name to emit (e.g. 'approval', 'hitl.approve', 'data.ready')",
    }),
    data: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description: "Event payload data. Passed to the resumed task as context.",
        },
      ),
    ),
  },
  { additionalProperties: true },
);

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function createNotifyTool(): AnyAgentTool {
  return {
    label: "Notify",
    name: "notify",
    ownerOnly: true,
    description: `Emit an event to the task event bus. If a task is waiting for this event, it will be resumed with the provided data.

Use this to:
- Provide human-in-the-loop approvals (e.g. eventName: "hitl.approve", data: { taskId: "...", comment: "looks good" })
- Signal data availability to waiting tasks
- Trigger any event-driven task resumption

The event is matched against registered wait conditions. If a match is found, the waiting task is immediately resumed with a new subagent that has full prior context + event data.`,
    parameters: NotifyToolSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const store = getTaskStore();
      if (!store) {
        return jsonResult({ error: "Task service is not running" });
      }

      const eventName = readStringParam(params, "eventName", { required: true });
      const data = params.data as Record<string, unknown> | undefined;

      // Emit event and check for matching wait conditions
      const result = emitEvent(store, eventName, data);

      if (result.matched && result.taskId) {
        // Look up the task for hook context
        const task = store.getTask(result.taskId);

        // Fire task_resumed hook
        if (task) {
          const hookRunner = getGlobalHookRunner();
          void hookRunner?.runTaskResumed(
            { taskId: result.taskId, title: task.title, eventName, eventData: data },
            { agentId: task.agentId, objectiveId: task.objectiveId },
          );
        }

        // Resume the task — spawns new subagent with prior steps + event data
        await resumeTaskFromEvent(result.taskId, data);

        // Nudge dispatcher to pick up any downstream changes
        nudgeDispatcher();

        return jsonResult({
          status: "emitted",
          matched: true,
          resumedTaskId: result.taskId,
          message: `Event "${eventName}" matched waiting task ${result.taskId}. Task resumed.`,
        });
      }

      return jsonResult({
        status: "emitted",
        matched: false,
        message: `Event "${eventName}" emitted. No matching wait condition found.`,
      });
    },
  };
}
