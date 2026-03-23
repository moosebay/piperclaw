/**
 * Task system agent tool registration.
 *
 * Returns the task-related tools that should be injected into the agent
 * tool list, so `openclaw-tools.ts` only needs a single spread.
 */
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createNotifyTool } from "../agents/tools/notify-tool.js";
import { createReportTool } from "../agents/tools/report-tool.js";
import { createTasksTool } from "../agents/tools/tasks-tool.js";
import { createWaitEventTool } from "../agents/tools/wait-event-tool.js";

export function createTaskAgentTools(options?: {
  agentSessionKey?: string;
  agentId?: string;
}): AnyAgentTool[] {
  return [
    createTasksTool({
      agentSessionKey: options?.agentSessionKey,
      agentId: options?.agentId,
    }),
    createReportTool(),
    createWaitEventTool(),
    createNotifyTool(),
  ];
}
