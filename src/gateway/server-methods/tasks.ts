import type { GatewayRequestHandlers } from "./types.js";

export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.objectives.list": ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const filter: Record<string, string> = {};
    if (typeof params?.status === "string") {
      filter.status = params.status;
    }
    if (typeof params?.agentId === "string") {
      filter.agentId = params.agentId;
    }
    const objectives = store.listObjectives(filter);
    const result = objectives.map((obj) => ({
      ...obj,
      progress: store.getObjectiveProgress(obj.id),
    }));
    respond(true, { objectives: result });
  },

  "tasks.objectives.get": ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const id = typeof params?.id === "string" ? params.id : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
      return;
    }
    const objective = store.getObjective(id);
    if (!objective) {
      respond(false, undefined, { code: "NOT_FOUND", message: `Objective ${id} not found` });
      return;
    }
    const progress = store.getObjectiveProgress(id);
    respond(true, { objective, progress });
  },

  "tasks.list": ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const filter: Record<string, string> = {};
    if (typeof params?.objectiveId === "string") {
      filter.objectiveId = params.objectiveId;
    }
    if (typeof params?.status === "string") {
      filter.status = params.status;
    }
    if (typeof params?.group === "string") {
      filter.group = params.group;
    }
    const tasks = store.listTasks(filter);
    respond(true, { tasks });
  },

  "tasks.get": ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const id = typeof params?.id === "string" ? params.id : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
      return;
    }
    const task = store.getTask(id);
    if (!task) {
      respond(false, undefined, { code: "NOT_FOUND", message: `Task ${id} not found` });
      return;
    }
    const report = store.getReportByTask(id);
    const steps = store.getSteps(id);
    const wait = store.getWaitConditionForTask(id);
    respond(true, { task, report: report ?? undefined, steps, waitCondition: wait ?? undefined });
  },

  "tasks.reports.list": ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const objectiveId = typeof params?.objectiveId === "string" ? params.objectiveId : "";
    if (!objectiveId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "objectiveId required" });
      return;
    }
    const reports = store.getReportsByObjective(objectiveId);
    respond(true, { reports });
  },

  "tasks.reports.get": ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const reportId = typeof params?.reportId === "string" ? params.reportId : "";
    if (!reportId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "reportId required" });
      return;
    }
    const report = store.getReport(reportId);
    if (!report) {
      respond(false, undefined, { code: "NOT_FOUND", message: `Report ${reportId} not found` });
      return;
    }
    respond(true, { report });
  },

  "tasks.steps.list": ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const taskId = typeof params?.taskId === "string" ? params.taskId : "";
    if (!taskId) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "taskId required" });
      return;
    }
    const steps = store.getSteps(taskId);
    respond(true, { steps });
  },

  "tasks.audit.list": ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const entityType =
      params?.entityType === "task" || params?.entityType === "objective"
        ? params.entityType
        : undefined;
    const entityId = typeof params?.entityId === "string" ? params.entityId : undefined;
    const limit = typeof params?.limit === "number" ? params.limit : 100;
    const entries = store.getAuditLog(entityType, entityId, limit);
    respond(true, { entries });
  },

  "tasks.approve": async ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const id = typeof params?.id === "string" ? params.id : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
      return;
    }
    const comment = typeof params?.comment === "string" ? params.comment : undefined;
    const { approveTask } = await import("../../tasks/hitl.js");
    const { matched } = approveTask(store, id, "rpc-user", comment);
    if (matched) {
      await _resumeTaskFromEvent(id, { taskId: id, approver: "rpc-user", comment });
    }
    respond(true, { id, approved: true, matched });
  },

  "tasks.reject": async ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const id = typeof params?.id === "string" ? params.id : "";
    if (!id) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "id required" });
      return;
    }
    const reason = typeof params?.reason === "string" ? params.reason : undefined;
    const { rejectTask } = await import("../../tasks/hitl.js");
    rejectTask(store, id, "rpc-user", reason);
    const task = store.getTask(id);
    if (task?.status === "waiting") {
      store.updateTaskStatus(id, "failed");
    }
    respond(true, { id, rejected: true });
  },

  "tasks.events.emit": async ({ params, respond }) => {
    const store = getStore(respond);
    if (!store) {
      return;
    }
    const eventName = typeof params?.eventName === "string" ? params.eventName : "";
    if (!eventName) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "eventName required" });
      return;
    }
    const data = params?.data;
    const { emitEvent } = await import("../../tasks/events.js");
    const result = emitEvent(store, eventName, data);
    if (result.matched && result.taskId) {
      await _resumeTaskFromEvent(result.taskId, data);
    }
    respond(true, result);
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type RespondFn = (
  ok: boolean,
  payload?: unknown,
  error?: { code: string; message: string },
) => void;

/**
 * Lazily resolve the task store from the runtime singleton.
 * Returns null (and sends an error response) when the service is not running.
 */
function getStore(respond: RespondFn): import("../../tasks/store.js").TaskStore | null {
  // Dynamic import avoided — getTaskStore is re-exported through the
  // runtime boundary which is statically imported at module level below.
  const store = _getTaskStore();
  if (!store) {
    respond(false, undefined, { code: "UNAVAILABLE", message: "Task service not running" });
    return null;
  }
  return store;
}

// Static import from the runtime boundary (no INEFFECTIVE_DYNAMIC_IMPORT).
import {
  getTaskStore as _getTaskStore,
  resumeTaskFromEvent as _resumeTaskFromEvent,
} from "../../tasks/service.runtime.js";
