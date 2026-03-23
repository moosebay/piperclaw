import { Type } from "@sinclair/typebox";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { registerWaitCondition } from "../../tasks/events.js";
import { getTaskStore } from "../../tasks/service.runtime.js";
import { type AnyAgentTool, jsonResult, readStringParam, readNumberParam } from "./common.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const WaitEventToolSchema = Type.Object(
  {
    taskId: Type.String({ description: "The current task ID (from your task prompt)" }),
    eventName: Type.String({
      description: "Event name to wait for (e.g. 'approval', 'hitl.approve', 'data.ready')",
    }),
    filter: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description:
            "Optional filter: event data must contain all these key/value pairs to match",
        },
      ),
    ),
    timeoutMs: Type.Optional(
      Type.Number({
        description: "Timeout in milliseconds. Task fails if event does not arrive in time.",
      }),
    ),
    stepName: Type.Optional(
      Type.String({
        description: "Name for a checkpoint step to record before suspending",
      }),
    ),
    stepResult: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description: "Result data for the checkpoint step",
        },
      ),
    ),
  },
  { additionalProperties: true },
);

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function createWaitEventTool(): AnyAgentTool {
  return {
    label: "Wait for Event",
    name: "wait_for_event",
    description: `Suspend the current task until an external event arrives. The task will be paused and a new subagent will be spawned with full context when the event is received.

Use this when your task needs external input (human approval, data from another system, etc.) before it can continue.

- taskId: Your current task ID (from the task prompt header).
- eventName: The event to wait for. Convention: "domain.action" (e.g. "hitl.approve", "data.ready").
- filter: Optional key/value filter. The event's data must contain all filter entries to match.
- timeoutMs: Optional timeout. If the event doesn't arrive within this time, the task fails.
- stepName/stepResult: Optional checkpoint. Record progress before suspending so it's available on resume.

After calling this tool, your session will end. A new session will be created with your prior steps and the event data when the event arrives.`,
    parameters: WaitEventToolSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const store = getTaskStore();
      if (!store) {
        return jsonResult({ error: "Task service is not running" });
      }

      const taskId = readStringParam(params, "taskId", { required: true });
      const eventName = readStringParam(params, "eventName", { required: true });
      const filter = params.filter as Record<string, unknown> | undefined;
      const timeoutMs = readNumberParam(params, "timeoutMs");

      // Validate the task exists and is running
      const task = store.getTask(taskId);
      if (!task) {
        return jsonResult({ error: `Task ${taskId} not found` });
      }
      if (task.status !== "running") {
        return jsonResult({
          error: `Task ${taskId} is in status "${task.status}", must be "running" to wait`,
        });
      }

      // Record step checkpoint if provided
      const stepName = readStringParam(params, "stepName");
      if (stepName) {
        const stepResult = params.stepResult;
        store.addStep(taskId, stepName, stepResult);
      }

      // Register wait condition
      const waitId = registerWaitCondition(store, taskId, eventName, filter, timeoutMs);

      // Transition task: running -> waiting
      store.updateTaskStatus(taskId, "waiting");

      // Fire task_waiting hook
      const hookRunner = getGlobalHookRunner();
      const timeoutAt = timeoutMs ? Date.now() + timeoutMs : undefined;
      void hookRunner?.runTaskWaiting(
        { taskId, title: task.title, eventName, timeoutAt },
        { agentId: task.agentId, objectiveId: task.objectiveId },
      );

      return jsonResult({
        status: "suspended",
        waitConditionId: waitId,
        message: `Task suspended. Will resume when event "${eventName}" arrives.`,
      });
    },
  };
}
