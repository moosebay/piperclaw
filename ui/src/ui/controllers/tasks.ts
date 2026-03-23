import type { GatewayBrowserClient } from "../gateway.ts";

// ---------------------------------------------------------------------------
// Types matching gateway RPC responses
// ---------------------------------------------------------------------------

export type TaskObjective = {
  id: string;
  agentId: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  createdAt: number;
  updatedAt: number;
  proposedBy: string;
  metadata?: Record<string, unknown>;
  progress?: {
    total: number;
    pending: number;
    scheduled: number;
    ready: number;
    running: number;
    waiting: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
};

export type TaskItem = {
  id: string;
  agentId: string;
  objectiveId: string;
  title: string;
  description?: string;
  status: string;
  priority: number;
  group?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  assignedSkill?: string;
  error?: string;
  reportId?: string;
  managerTrigger: string;
  maxRetries: number;
  retryCount: number;
  dependsOn?: string[];
};

export type TaskReport = {
  id: string;
  taskId: string;
  title: string;
  summary: string;
  content: string;
  format: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
};

export type TaskStep = {
  id: string;
  taskId: string;
  stepName: string;
  stepIndex: number;
  status: string;
  result?: unknown;
  createdAt: number;
};

export type AuditEntry = {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  fromStatus?: string;
  toStatus?: string;
  actor?: string;
  detail?: string;
  createdAt: number;
};

export type WaitCondition = {
  id: string;
  taskId: string;
  eventName: string;
  timeoutAt?: number;
};

export type TaskDetail = {
  task: TaskItem;
  report?: TaskReport;
  steps: TaskStep[];
  waitCondition?: WaitCondition;
};

// ---------------------------------------------------------------------------
// Controller state
// ---------------------------------------------------------------------------

export type PiperSkill = {
  name: string;
  description?: string;
  emoji?: string;
  piper: {
    role: "manager" | "worker";
    type?: string;
    description?: string;
    workers?: string[];
    capabilities?: string[];
  };
};

export type TasksState = {
  objectives: TaskObjective[];
  objectivesLoading: boolean;
  objectivesError: string | null;
  tasks: TaskItem[];
  tasksLoading: boolean;
  tasksError: string | null;
  taskDetail: TaskDetail | null;
  taskDetailLoading: boolean;
  auditLog: AuditEntry[];
  auditLoading: boolean;
  auditFilter: string;
  piperSkills: PiperSkill[];
  piperSkillsLoading: boolean;
  selectedObjectiveId: string | null;
  selectedTaskId: string | null;
  taskStatusFilter: string;
  taskSkillFilter: string;
};

export const DEFAULT_TASKS_STATE: TasksState = {
  objectives: [],
  objectivesLoading: false,
  objectivesError: null,
  tasks: [],
  tasksLoading: false,
  tasksError: null,
  taskDetail: null,
  taskDetailLoading: false,
  auditLog: [],
  auditLoading: false,
  auditFilter: "",
  piperSkills: [],
  piperSkillsLoading: false,
  selectedObjectiveId: null,
  selectedTaskId: null,
  taskStatusFilter: "all",
  taskSkillFilter: "all",
};

// ---------------------------------------------------------------------------
// Controller functions
// ---------------------------------------------------------------------------

export async function loadObjectives(
  client: GatewayBrowserClient,
  state: TasksState,
): Promise<void> {
  state.objectivesLoading = true;
  state.objectivesError = null;
  try {
    const result = await client.request<{ objectives?: TaskObjective[] }>(
      "tasks.objectives.list",
      {},
    );
    state.objectives = result?.objectives ?? [];
  } catch (err) {
    state.objectivesError = String(err);
  } finally {
    state.objectivesLoading = false;
  }
}

export async function loadTasks(
  client: GatewayBrowserClient,
  state: TasksState,
  filter?: { objectiveId?: string; status?: string },
): Promise<void> {
  state.tasksLoading = true;
  state.tasksError = null;
  try {
    const params: Record<string, unknown> = {};
    if (filter?.objectiveId) {
      params.objectiveId = filter.objectiveId;
    }
    if (filter?.status && filter.status !== "all") {
      params.status = filter.status;
    }
    const result = await client.request<{ tasks?: TaskItem[] }>("tasks.list", params);
    state.tasks = result?.tasks ?? [];
  } catch (err) {
    state.tasksError = String(err);
  } finally {
    state.tasksLoading = false;
  }
}

export async function loadTaskDetail(
  client: GatewayBrowserClient,
  state: TasksState,
  taskId: string,
): Promise<void> {
  state.taskDetailLoading = true;
  state.selectedTaskId = taskId;
  try {
    const result = await client.request<TaskDetail>("tasks.get", { id: taskId });
    state.taskDetail = result;
  } catch {
    state.taskDetail = null;
  } finally {
    state.taskDetailLoading = false;
  }
}

export async function loadAuditLog(
  client: GatewayBrowserClient,
  state: TasksState,
  entityId?: string,
): Promise<void> {
  state.auditLoading = true;
  try {
    const params: Record<string, unknown> = { limit: 200 };
    if (entityId) {
      params.entityId = entityId;
    }
    const result = await client.request<{ entries?: AuditEntry[] }>("tasks.audit.list", params);
    state.auditLog = result?.entries ?? [];
  } catch {
    state.auditLog = [];
  } finally {
    state.auditLoading = false;
  }
}

export async function approveTask(
  client: GatewayBrowserClient,
  taskId: string,
): Promise<void> {
  await client.request("tasks.approve", { id: taskId });
}

export async function rejectTask(
  client: GatewayBrowserClient,
  taskId: string,
  reason?: string,
): Promise<void> {
  await client.request("tasks.reject", { id: taskId, reason });
}

export async function cancelObjective(
  client: GatewayBrowserClient,
  objectiveId: string,
): Promise<void> {
  await client.request("tasks.objectives.cancel", { id: objectiveId });
}

export async function loadPiperSkills(
  client: GatewayBrowserClient,
  state: TasksState,
): Promise<void> {
  state.piperSkillsLoading = true;
  try {
    const result = await client.request<{ skills: PiperSkill[] }>("tasks.skills.list", {});
    state.piperSkills = result?.skills ?? [];
  } catch {
    state.piperSkills = [];
  } finally {
    state.piperSkillsLoading = false;
  }
}
