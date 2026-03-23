import { Type } from "@sinclair/typebox";
import { getTaskStore } from "../../tasks/service.runtime.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ReportToolSchema = Type.Object(
  {
    action: Type.Unsafe<"create">({
      type: "string",
      enum: ["create"],
    }),
    taskId: Type.String({ description: "Task ID this report belongs to" }),
    title: Type.String({ description: "Report title" }),
    summary: Type.String({
      description: "2-3 sentence overview for manager context and downstream tasks",
    }),
    content: Type.String({
      description: "Full report body in markdown",
    }),
    format: Type.Optional(
      Type.Unsafe<"markdown" | "json">({
        type: "string",
        enum: ["markdown", "json"],
      }),
    ),
  },
  { additionalProperties: true },
);

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function createReportTool(): AnyAgentTool {
  return {
    label: "Report",
    name: "report",
    description: `Create a report for a task. Reports are the structured output of worker task execution.

- taskId: The task ID (provided in your task prompt).
- summary: A concise 2-3 sentence overview of your findings. Injected into manager context and downstream task prompts.
- content: The full report body in markdown. Stored for reference.

Call this tool once with your findings before completing your task.`,
    parameters: ReportToolSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const store = getTaskStore();
      if (!store) {
        return jsonResult({ error: "Task service is not running" });
      }

      const action = readStringParam(params, "action", { required: true });
      if (action !== "create") {
        return jsonResult({ error: `Unknown action: ${action}. Only "create" is supported.` });
      }

      const taskId = readStringParam(params, "taskId", { required: true });
      const title = readStringParam(params, "title", { required: true });
      const summary = readStringParam(params, "summary", { required: true });
      const content = readStringParam(params, "content", { required: true });
      const format = params.format === "json" ? "json" : "markdown";

      const reportId = store.createReport({
        taskId,
        title,
        summary,
        content,
        format,
      });

      return jsonResult({ reportId, status: "created" });
    },
  };
}
