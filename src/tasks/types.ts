// --- Objectives ---

export type ObjectiveStatus = "active" | "paused" | "completed" | "cancelled";

export type RateLimit = {
  maxPerWindow: number;
  windowMs: number;
};

export type ObjectiveRecord = {
  id: string;
  agentId: string;
  title: string;
  description: string;
  status: ObjectiveStatus;
  priority: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  proposedBy: "user" | "manager";
  metadata?: Record<string, unknown>;
  rateLimit?: RateLimit;
  interTaskDelayMs?: number;
};

export type CreateObjectiveParams = {
  agentId: string;
  title: string;
  description: string;
  priority?: number;
  proposedBy?: "user" | "manager";
  metadata?: Record<string, unknown>;
  rateLimit?: RateLimit;
  interTaskDelayMs?: number;
};

// --- Tasks ---

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "ready"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

/** Defines when a task triggers manager re-invocation. */
export type ManagerTrigger = "none" | "on_complete" | "on_fail";

export type TaskRecord = {
  id: string;
  agentId: string;
  objectiveId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: number;
  group?: string;
  createdAt: number;
  updatedAt: number;
  scheduledAt?: number;
  startedAt?: number;
  completedAt?: number;
  createdBySession?: string;
  assignedAgentId?: string;
  assignedSkill?: string;
  runId?: string;
  result?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  dependsOn?: string[];
  dependents?: string[];
  reportId?: string;
  managerTrigger: ManagerTrigger;
  maxRetries: number;
  retryCount: number;
  retryAfterMs?: number;
};

export type CreateTaskParams = {
  agentId: string;
  objectiveId: string;
  title: string;
  description?: string;
  priority?: number;
  group?: string;
  scheduledAt?: number;
  assignedAgentId?: string;
  assignedSkill?: string;
  dependsOn?: string[];
  metadata?: Record<string, unknown>;
  createdBySession?: string;
  managerTrigger?: ManagerTrigger;
  maxRetries?: number;
  retryAfterMs?: number;
};

// --- State Machine ---

/** Legal state transitions — enforced by store. */
export const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["ready", "scheduled", "cancelled"],
  scheduled: ["ready", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["completed", "failed", "waiting"],
  waiting: ["running", "failed", "cancelled"],
  failed: ["pending"],
  completed: [],
  cancelled: [],
};

// --- Steps (durable checkpoints) ---

export type TaskStepStatus = "completed" | "failed";

export type TaskStep = {
  id: string;
  taskId: string;
  stepName: string;
  stepIndex: number;
  status: TaskStepStatus;
  result?: unknown;
  createdAt: number;
  completedAt?: number;
};

// --- Reports ---

export type ReportRecord = {
  id: string;
  taskId: string;
  objectiveId: string;
  agentId: string;
  title: string;
  summary: string;
  content: string;
  format: "markdown" | "json";
  createdAt: number;
  metadata?: Record<string, unknown>;
};

export type CreateReportParams = {
  taskId: string;
  title: string;
  summary: string;
  content: string;
  format?: "markdown" | "json";
  metadata?: Record<string, unknown>;
};

// --- Manager Wake Reasons ---

export type ManagerWakeReason =
  | { reason: "task_failed"; taskId: string }
  | { reason: "task_review"; taskId: string }
  | { reason: "group_completed"; group: string }
  | { reason: "objective_completed"; objectiveId: string }
  | { reason: "user_interrupt"; objectiveId: string };

// --- Progress ---

export type ObjectiveProgress = {
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

// --- Events (event bus) ---

export type TaskEvent = {
  id: string;
  eventName: string;
  data?: unknown;
  createdAt: number;
  consumedByTaskId?: string;
  expiresAt?: number;
};

export type WaitCondition = {
  id: string;
  taskId: string;
  eventName: string;
  filter?: Record<string, unknown>;
  timeoutAt?: number;
  createdAt: number;
};

// --- Task Filter ---

export type TaskFilter = {
  agentId?: string;
  objectiveId?: string;
  status?: TaskStatus;
  group?: string;
};

export type ObjectiveFilter = {
  agentId?: string;
  status?: ObjectiveStatus;
};
