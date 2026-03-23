/**
 * Runtime boundary for lazy-loading task service.
 * Static callers import from here; dynamic callers import this file dynamically.
 * Prevents [INEFFECTIVE_DYNAMIC_IMPORT] build warnings.
 */
export {
  getTaskStore,
  getTaskDispatcher,
  nudgeDispatcher,
  resumeTaskFromEvent,
  startTaskService,
  stopTaskService,
  notifyTaskCompletionFromSubagent,
  TaskService,
} from "./service.js";

export type { TaskServiceConfig } from "./service.js";
