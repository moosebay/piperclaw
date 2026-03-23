import { Type } from "@sinclair/typebox";
import { addValidatedDependency } from "../../tasks/deps.js";
import { approveTask, rejectTask } from "../../tasks/hitl.js";
import { getTaskStore, nudgeDispatcher, resumeTaskFromEvent } from "../../tasks/service.runtime.js";
import type {
  CreateObjectiveParams,
  CreateTaskParams,
  ObjectiveFilter,
  ObjectiveStatus,
  TaskFilter,
  TaskStatus,
} from "../../tasks/types.js";
import { stringEnum, optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TASK_ACTIONS = [
  "objectives.create",
  "objectives.list",
  "objectives.get",
  "objectives.complete",
  "objectives.cancel",
  "objectives.pause",
  "objectives.resume",
  "tasks.create",
  "tasks.list",
  "tasks.get",
  "tasks.cancel",
  "tasks.update",
  "tasks.approve",
  "tasks.reject",
  "reports.get",
  "reports.list",
  "audit.list",
] as const;

const TasksToolSchema = Type.Object(
  {
    action: stringEnum(TASK_ACTIONS),
    // Objective fields
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    priority: Type.Optional(Type.Number()),
    proposedBy: optionalStringEnum(["user", "manager"] as const),
    // Task fields
    objectiveId: Type.Optional(Type.String()),
    group: Type.Optional(Type.String()),
    scheduledAt: Type.Optional(Type.Number()),
    assignedAgentId: Type.Optional(Type.String()),
    assignedSkill: Type.Optional(Type.String()),
    dependsOn: Type.Optional(Type.Array(Type.String())),
    managerTrigger: optionalStringEnum(["none", "on_complete", "on_fail"] as const),
    maxRetries: Type.Optional(Type.Number()),
    retryAfterMs: Type.Optional(Type.Number()),
    // Common
    id: Type.Optional(Type.String()),
    taskId: Type.Optional(Type.String()),
    reportId: Type.Optional(Type.String()),
    // Filter fields
    status: optionalStringEnum([
      "active",
      "paused",
      "completed",
      "cancelled",
      "pending",
      "scheduled",
      "ready",
      "running",
      "waiting",
      "failed",
    ] as const),
    // Update fields
    metadata: Type.Optional(Type.Object({}, { additionalProperties: true })),
    // Audit fields
    entityType: optionalStringEnum(["task", "objective"] as const),
    // Objective rate limiting
    rateLimitMaxPerWindow: Type.Optional(
      Type.Number({ description: "Max tasks completed per window" }),
    ),
    rateLimitWindowMs: Type.Optional(Type.Number({ description: "Rate limit window in ms" })),
    interTaskDelayMs: Type.Optional(
      Type.Number({ description: "Minimum ms between task dispatches" }),
    ),
  },
  { additionalProperties: true },
);

// ---------------------------------------------------------------------------
// Tool options
// ---------------------------------------------------------------------------

type TasksToolOptions = {
  agentSessionKey?: string;
  agentId?: string;
};

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export function createTasksTool(opts?: TasksToolOptions): AnyAgentTool {
  return {
    label: "Tasks",
    name: "tasks",
    ownerOnly: true,
    description: `Manage objectives, tasks, and reports for the task-driven workflow system.

ACTIONS:

Objectives:
- objectives.create: Create a new objective (requires title, description)
- objectives.list: List objectives (optional filter: status)
- objectives.get: Get objective details with progress (requires id)
- objectives.complete: Mark objective done (requires id)
- objectives.cancel: Cancel objective and all non-terminal tasks (requires id)
- objectives.pause / objectives.resume: Pause or resume an objective (requires id)

Tasks:
- tasks.create: Create a task (requires objectiveId, title; optional: description, priority, group, scheduledAt, assignedSkill, dependsOn, managerTrigger, maxRetries)
- tasks.list: List tasks (optional filter: status, objectiveId, group)
- tasks.get: Get task details with report summary (requires id)
- tasks.cancel: Cancel a pending/scheduled/ready task (requires id)
- tasks.update: Update description/metadata of a pending task (requires id)
- tasks.approve: Approve a waiting task (HITL) (requires id; optional: description for comment)
- tasks.reject: Reject a waiting task (HITL) (requires id; optional: description for reason)

Reports:
- reports.get: Get full report content (requires reportId)
- reports.list: List reports by objective (requires objectiveId)

Audit:
- audit.list: Get audit log entries (optional: id for entity ID, entityType for "task"|"objective")`,
    parameters: TasksToolSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const store = getTaskStore();
      if (!store) {
        return jsonResult({ error: "Task service is not running" });
      }

      const action = readStringParam(params, "action", { required: true });
      const agentId = opts?.agentId ?? "main";

      switch (action) {
        // -----------------------------------------------------------------
        // Objectives
        // -----------------------------------------------------------------
        case "objectives.create": {
          const title = readStringParam(params, "title", { required: true });
          const description = readStringParam(params, "description", { required: true });
          const rateMax =
            typeof params.rateLimitMaxPerWindow === "number"
              ? params.rateLimitMaxPerWindow
              : undefined;
          const rateWindow =
            typeof params.rateLimitWindowMs === "number" ? params.rateLimitWindowMs : undefined;
          const createParams: CreateObjectiveParams = {
            agentId,
            title,
            description,
            priority: typeof params.priority === "number" ? params.priority : undefined,
            proposedBy:
              params.proposedBy === "manager" || params.proposedBy === "user"
                ? params.proposedBy
                : "manager",
            metadata: params.metadata as Record<string, unknown> | undefined,
            rateLimit:
              rateMax && rateWindow ? { maxPerWindow: rateMax, windowMs: rateWindow } : undefined,
            interTaskDelayMs:
              typeof params.interTaskDelayMs === "number" ? params.interTaskDelayMs : undefined,
          };
          const id = store.createObjective(createParams);
          return jsonResult({ id, status: "created" });
        }

        case "objectives.list": {
          const filter: ObjectiveFilter = { agentId };
          if (params.status) {
            filter.status = params.status as ObjectiveStatus;
          }
          const objectives = store.listObjectives(filter);
          return jsonResult({ objectives });
        }

        case "objectives.get": {
          const id = readStringParam(params, "id", { required: true });
          const objective = store.getObjective(id);
          if (!objective) {
            return jsonResult({ error: `Objective ${id} not found` });
          }
          const progress = store.getObjectiveProgress(id);
          return jsonResult({ objective, progress });
        }

        case "objectives.complete": {
          const id = readStringParam(params, "id", { required: true });
          store.markObjectiveCompleted(id);
          return jsonResult({ id, status: "completed" });
        }

        case "objectives.cancel": {
          const id = readStringParam(params, "id", { required: true });
          const cancelledCount = store.cancelObjective(id);
          return jsonResult({ id, status: "cancelled", cancelledTasks: cancelledCount });
        }

        case "objectives.pause": {
          const id = readStringParam(params, "id", { required: true });
          store.updateObjectiveStatus(id, "paused");
          return jsonResult({ id, status: "paused" });
        }

        case "objectives.resume": {
          const id = readStringParam(params, "id", { required: true });
          store.updateObjectiveStatus(id, "active");
          return jsonResult({ id, status: "active" });
        }

        // -----------------------------------------------------------------
        // Tasks
        // -----------------------------------------------------------------
        case "tasks.create": {
          const objectiveId = readStringParam(params, "objectiveId", { required: true });
          const title = readStringParam(params, "title", { required: true });
          const createParams: CreateTaskParams = {
            agentId,
            objectiveId,
            title,
            description: typeof params.description === "string" ? params.description : undefined,
            priority: typeof params.priority === "number" ? params.priority : undefined,
            group: typeof params.group === "string" ? params.group : undefined,
            scheduledAt: typeof params.scheduledAt === "number" ? params.scheduledAt : undefined,
            assignedAgentId:
              typeof params.assignedAgentId === "string" ? params.assignedAgentId : undefined,
            assignedSkill:
              typeof params.assignedSkill === "string" ? params.assignedSkill : undefined,
            managerTrigger:
              params.managerTrigger === "none" ||
              params.managerTrigger === "on_complete" ||
              params.managerTrigger === "on_fail"
                ? params.managerTrigger
                : undefined,
            maxRetries: typeof params.maxRetries === "number" ? params.maxRetries : undefined,
            retryAfterMs: typeof params.retryAfterMs === "number" ? params.retryAfterMs : undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
            createdBySession: opts?.agentSessionKey,
          };
          const taskId = store.createTask(createParams);

          // Add dependencies with DAG validation
          const dependsOn = params.dependsOn;
          if (Array.isArray(dependsOn)) {
            for (const depId of dependsOn) {
              if (typeof depId === "string") {
                addValidatedDependency(taskId, depId, store);
              }
            }
          }

          nudgeDispatcher();
          return jsonResult({ id: taskId, status: "created" });
        }

        case "tasks.list": {
          const filter: TaskFilter = {};
          if (params.objectiveId) {
            filter.objectiveId = params.objectiveId as string;
          }
          if (params.status) {
            filter.status = params.status as TaskStatus;
          }
          if (params.group) {
            filter.group = params.group as string;
          }
          if (!filter.objectiveId && !filter.status && !filter.group) {
            filter.agentId = agentId;
          }
          const tasks = store.listTasks(filter);
          return jsonResult({ tasks });
        }

        case "tasks.get": {
          const id = readStringParam(params, "id", { required: true });
          const task = store.getTask(id);
          if (!task) {
            return jsonResult({ error: `Task ${id} not found` });
          }
          const report = store.getReportByTask(id);
          return jsonResult({
            task,
            report: report
              ? { id: report.id, title: report.title, summary: report.summary }
              : undefined,
          });
        }

        case "tasks.cancel": {
          const id = readStringParam(params, "id", { required: true });
          const task = store.getTask(id);
          if (!task) {
            return jsonResult({ error: `Task ${id} not found` });
          }
          if (task.status !== "pending" && task.status !== "scheduled" && task.status !== "ready") {
            return jsonResult({
              error: `Cannot cancel task in status ${task.status}`,
            });
          }
          store.updateTaskStatus(id, "cancelled");
          return jsonResult({ id, status: "cancelled" });
        }

        case "tasks.update": {
          const id = readStringParam(params, "id", { required: true });
          const task = store.getTask(id);
          if (!task) {
            return jsonResult({ error: `Task ${id} not found` });
          }
          if (task.status !== "pending" && task.status !== "scheduled") {
            return jsonResult({
              error: `Cannot update task in status ${task.status} — only pending/scheduled tasks can be updated`,
            });
          }
          store.updateTaskDetails(id, {
            description: typeof params.description === "string" ? params.description : undefined,
            metadata: params.metadata as Record<string, unknown> | undefined,
            priority: typeof params.priority === "number" ? params.priority : undefined,
          });
          return jsonResult({ id, status: "updated" });
        }

        // -----------------------------------------------------------------
        // HITL (approve / reject)
        // -----------------------------------------------------------------
        case "tasks.approve": {
          const id = readStringParam(params, "id", { required: true });
          const comment = typeof params.description === "string" ? params.description : undefined;
          const { matched } = approveTask(store, id, undefined, comment);
          if (matched) {
            // Resume the task with approval context
            void resumeTaskFromEvent(id, { taskId: id, approver: "agent", comment });
            nudgeDispatcher();
          }
          return jsonResult({ id, approved: true, matched });
        }

        case "tasks.reject": {
          const id = readStringParam(params, "id", { required: true });
          const reason = typeof params.description === "string" ? params.description : undefined;
          const { matched } = rejectTask(store, id, undefined, reason);
          if (matched) {
            // Transition task to failed
            store.updateTaskStatus(id, "failed");
          }
          return jsonResult({ id, rejected: true, matched });
        }

        // -----------------------------------------------------------------
        // Reports
        // -----------------------------------------------------------------
        case "reports.get": {
          const reportId = readStringParam(params, "reportId", { required: true });
          const report = store.getReport(reportId);
          if (!report) {
            return jsonResult({ error: `Report ${reportId} not found` });
          }
          return jsonResult({ report });
        }

        case "reports.list": {
          const objectiveId = readStringParam(params, "objectiveId", { required: true });
          const reports = store.getReportsByObjective(objectiveId);
          return jsonResult({
            reports: reports.map((r) => ({
              id: r.id,
              taskId: r.taskId,
              title: r.title,
              summary: r.summary,
              format: r.format,
              createdAt: r.createdAt,
            })),
          });
        }

        // -----------------------------------------------------------------
        // Audit
        // -----------------------------------------------------------------
        case "audit.list": {
          const entityType =
            params.entityType === "task" || params.entityType === "objective"
              ? params.entityType
              : undefined;
          const entityId = typeof params.id === "string" ? params.id : undefined;
          const entries = store.getAuditLog(entityType, entityId);
          return jsonResult({ entries });
        }

        default:
          return jsonResult({ error: `Unknown action: ${action}` });
      }
    },
  };
}
