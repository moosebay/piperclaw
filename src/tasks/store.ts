import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { resolveConfigDir } from "../utils.js";
import type {
  CreateObjectiveParams,
  CreateReportParams,
  CreateTaskParams,
  ObjectiveFilter,
  ObjectiveProgress,
  ObjectiveRecord,
  ObjectiveStatus,
  ReportRecord,
  TaskEvent,
  TaskFilter,
  TaskRecord,
  TaskStatus,
  TaskStep,
  WaitCondition,
} from "./types.js";

type SqlParam = string | number | null;

// Re-import the value (not just type) for transition enforcement
import { LEGAL_TRANSITIONS as TRANSITIONS } from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  priority INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  proposed_by TEXT NOT NULL DEFAULT 'user',
  metadata TEXT,
  rate_limit TEXT,
  inter_task_delay_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER DEFAULT 0,
  task_group TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  scheduled_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  created_by_session TEXT,
  assigned_agent_id TEXT,
  assigned_skill TEXT,
  run_id TEXT,
  result TEXT,
  error TEXT,
  metadata TEXT,
  report_id TEXT,
  manager_trigger TEXT NOT NULL DEFAULT 'none',
  max_retries INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_after_ms INTEGER DEFAULT 5000,
  FOREIGN KEY (objective_id) REFERENCES objectives(id)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown',
  created_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (objective_id) REFERENCES objectives(id)
);

CREATE TABLE IF NOT EXISTS task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  step_name TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  result TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  data TEXT,
  created_at INTEGER NOT NULL,
  consumed_by_task_id TEXT,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_events_name ON task_events(event_name);
CREATE INDEX IF NOT EXISTS idx_task_events_unconsumed ON task_events(event_name, consumed_by_task_id)
  WHERE consumed_by_task_id IS NULL;

CREATE TABLE IF NOT EXISTS task_wait_conditions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  filter TEXT,
  timeout_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
CREATE INDEX IF NOT EXISTS idx_task_waits_event ON task_wait_conditions(event_name);
CREATE INDEX IF NOT EXISTS idx_task_waits_timeout ON task_wait_conditions(timeout_at)
  WHERE timeout_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_objective ON tasks(objective_id);
CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(task_group);
CREATE INDEX IF NOT EXISTS idx_tasks_running ON tasks(status, started_at)
  WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id)
  WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_objectives_status ON objectives(status);
CREATE INDEX IF NOT EXISTS idx_objectives_agent ON objectives(agent_id);
CREATE INDEX IF NOT EXISTS idx_reports_task ON reports(task_id);
CREATE INDEX IF NOT EXISTS idx_reports_objective ON reports(objective_id);
`;

// ---------------------------------------------------------------------------
// Row types (snake_case from SQLite)
// ---------------------------------------------------------------------------

type ObjectiveRow = {
  id: string;
  agent_id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  proposed_by: string;
  metadata: string | null;
  rate_limit: string | null;
  inter_task_delay_ms: number | null;
};

type TaskRow = {
  id: string;
  agent_id: string;
  objective_id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  task_group: string | null;
  created_at: number;
  updated_at: number;
  scheduled_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  created_by_session: string | null;
  assigned_agent_id: string | null;
  assigned_skill: string | null;
  run_id: string | null;
  result: string | null;
  error: string | null;
  metadata: string | null;
  report_id: string | null;
  manager_trigger: string;
  max_retries: number;
  retry_count: number;
  retry_after_ms: number | null;
};

type ReportRow = {
  id: string;
  task_id: string;
  objective_id: string;
  agent_id: string;
  title: string;
  summary: string;
  content: string;
  format: string;
  created_at: number;
  metadata: string | null;
};

type TaskStepRow = {
  id: string;
  task_id: string;
  step_name: string;
  step_index: number;
  status: string;
  result: string | null;
  created_at: number;
  completed_at: number | null;
};

type TaskEventRow = {
  id: string;
  event_name: string;
  data: string | null;
  created_at: number;
  consumed_by_task_id: string | null;
  expires_at: number | null;
};

type WaitConditionRow = {
  id: string;
  task_id: string;
  event_name: string;
  filter: string | null;
  timeout_at: number | null;
  created_at: number;
};

// ---------------------------------------------------------------------------
// Row → Record helpers
// ---------------------------------------------------------------------------

function objectiveFromRow(row: ObjectiveRow): ObjectiveRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    description: row.description,
    status: row.status as ObjectiveRecord["status"],
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    proposedBy: row.proposed_by as ObjectiveRecord["proposedBy"],
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    rateLimit: row.rate_limit ? JSON.parse(row.rate_limit) : undefined,
    interTaskDelayMs: row.inter_task_delay_ms ?? undefined,
  };
}

function taskFromRow(row: TaskRow, deps?: string[], dependents?: string[]): TaskRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    objectiveId: row.objective_id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as TaskRecord["status"],
    priority: row.priority,
    group: row.task_group ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    scheduledAt: row.scheduled_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdBySession: row.created_by_session ?? undefined,
    assignedAgentId: row.assigned_agent_id ?? undefined,
    assignedSkill: row.assigned_skill ?? undefined,
    runId: row.run_id ?? undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    error: row.error ?? undefined,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    reportId: row.report_id ?? undefined,
    managerTrigger: row.manager_trigger as TaskRecord["managerTrigger"],
    maxRetries: row.max_retries,
    retryCount: row.retry_count,
    retryAfterMs: row.retry_after_ms ?? undefined,
    dependsOn: deps,
    dependents,
  };
}

function reportFromRow(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    objectiveId: row.objective_id,
    agentId: row.agent_id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    format: row.format as ReportRecord["format"],
    createdAt: row.created_at,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
  };
}

function stepFromRow(row: TaskStepRow): TaskStep {
  return {
    id: row.id,
    taskId: row.task_id,
    stepName: row.step_name,
    stepIndex: row.step_index,
    status: row.status as TaskStep["status"],
    result: row.result ? JSON.parse(row.result) : undefined,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function eventFromRow(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    eventName: row.event_name,
    data: row.data ? JSON.parse(row.data) : undefined,
    createdAt: row.created_at,
    consumedByTaskId: row.consumed_by_task_id ?? undefined,
    expiresAt: row.expires_at ?? undefined,
  };
}

function waitConditionFromRow(row: WaitConditionRow): WaitCondition {
  return {
    id: row.id,
    taskId: row.task_id,
    eventName: row.event_name,
    filter: row.filter ? (JSON.parse(row.filter) as Record<string, unknown>) : undefined,
    timeoutAt: row.timeout_at ?? undefined,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// TaskStore
// ---------------------------------------------------------------------------

export class TaskStore {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(resolveConfigDir(), "state", "tasks.sqlite");
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });

    const { DatabaseSync } = requireNodeSqlite();
    this.db = new DatabaseSync(resolvedPath);

    // Concurrency hardening
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");

    // Create schema
    this.db.exec(SCHEMA_SQL);

    // Migrate existing databases that may lack new columns
    this.ensureMigrations();
  }

  close(): void {
    this.db.close();
  }

  private ensureMigrations(): void {
    const cols = this.db.prepare("PRAGMA table_info(objectives)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("rate_limit")) {
      this.db.exec("ALTER TABLE objectives ADD COLUMN rate_limit TEXT");
    }
    if (!colNames.has("inter_task_delay_ms")) {
      this.db.exec("ALTER TABLE objectives ADD COLUMN inter_task_delay_ms INTEGER");
    }
  }

  /**
   * Run a callback inside a BEGIN/COMMIT transaction. Rolls back on error.
   * Safe for nesting: if already inside a transaction, runs fn() directly.
   */
  private inTransaction = false;

  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.inTransaction = true;
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback may fail if transaction was already aborted
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  // -------------------------------------------------------------------------
  // Objectives
  // -------------------------------------------------------------------------

  createObjective(params: CreateObjectiveParams): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO objectives (id, agent_id, title, description, status, priority, created_at, updated_at, proposed_by, metadata, rate_limit, inter_task_delay_ms)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.agentId,
        params.title,
        params.description,
        params.priority ?? 0,
        now,
        now,
        params.proposedBy ?? "user",
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.rateLimit ? JSON.stringify(params.rateLimit) : null,
        params.interTaskDelayMs ?? null,
      );
    return id;
  }

  getObjective(id: string): ObjectiveRecord | undefined {
    const row = this.db.prepare("SELECT * FROM objectives WHERE id = ?").get(id) as
      | ObjectiveRow
      | undefined;
    return row ? objectiveFromRow(row) : undefined;
  }

  listObjectives(filter?: ObjectiveFilter): ObjectiveRecord[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter?.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM objectives ${where} ORDER BY priority DESC, created_at DESC`)
      .all(...params) as ObjectiveRow[];
    return rows.map(objectiveFromRow);
  }

  updateObjectiveStatus(id: string, status: ObjectiveStatus): void {
    const now = Date.now();
    const completedAt = status === "completed" ? now : null;
    this.db
      .prepare(
        `UPDATE objectives SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?`,
      )
      .run(status, now, completedAt, id);
  }

  markObjectiveCompleted(id: string): void {
    this.updateObjectiveStatus(id, "completed");
  }

  getObjectiveProgress(objectiveId: string): ObjectiveProgress {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) as cnt FROM tasks WHERE objective_id = ? GROUP BY status")
      .all(objectiveId) as Array<{ status: string; cnt: number }>;

    const progress: ObjectiveProgress = {
      total: 0,
      pending: 0,
      scheduled: 0,
      ready: 0,
      running: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of rows) {
      const count = row.cnt;
      progress.total += count;
      if (row.status in progress) {
        (progress as Record<string, number>)[row.status] = count;
      }
    }
    return progress;
  }

  /** Count tasks completed within a time window for rate limiting. */
  countRecentCompletions(objectiveId: string, windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM tasks WHERE objective_id = ? AND status = 'completed' AND completed_at > ?",
      )
      .get(objectiveId, cutoff) as { cnt: number };
    return row.cnt;
  }

  // -------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------

  createTask(params: CreateTaskParams): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    const initialStatus = params.scheduledAt && params.scheduledAt > now ? "scheduled" : "pending";

    this.db
      .prepare(
        `INSERT INTO tasks (
          id, agent_id, objective_id, title, description, status, priority,
          task_group, created_at, updated_at, scheduled_at,
          created_by_session, assigned_agent_id, assigned_skill,
          metadata, manager_trigger, max_retries, retry_count, retry_after_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        params.agentId,
        params.objectiveId,
        params.title,
        params.description ?? null,
        initialStatus,
        params.priority ?? 0,
        params.group ?? null,
        now,
        now,
        params.scheduledAt ?? null,
        params.createdBySession ?? null,
        params.assignedAgentId ?? null,
        params.assignedSkill ?? null,
        params.metadata ? JSON.stringify(params.metadata) : null,
        params.managerTrigger ?? "none",
        params.maxRetries ?? 0,
        params.retryAfterMs ?? 5000,
      );

    return id;
  }

  getTask(id: string): TaskRecord | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    if (!row) {
      return undefined;
    }
    const deps = this.getDependencies(id);
    const dependents = this.getDependents(id);
    return taskFromRow(row, deps, dependents);
  }

  /** Find a task by its subagent runId. Includes running and waiting statuses. */
  getTaskByRunId(runId: string): TaskRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE run_id = ? AND status IN ('running', 'waiting')")
      .get(runId) as TaskRow | undefined;
    if (!row) {
      return undefined;
    }
    return taskFromRow(row);
  }

  listTasks(filter?: TaskFilter): TaskRecord[] {
    const clauses: string[] = [];
    const params: SqlParam[] = [];
    if (filter?.agentId) {
      clauses.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter?.objectiveId) {
      clauses.push("objective_id = ?");
      params.push(filter.objectiveId);
    }
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.group) {
      clauses.push("task_group = ?");
      params.push(filter.group);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY priority DESC, created_at ASC`)
      .all(...params) as TaskRow[];
    return rows.map((r) => taskFromRow(r));
  }

  updateTaskStatus(id: string, newStatus: TaskStatus): boolean {
    const row = this.db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as
      | { status: string }
      | undefined;
    if (!row) {
      throw new Error(`Task ${id} not found`);
    }

    const current = row.status as TaskStatus;
    const allowed = TRANSITIONS[current];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Illegal transition: ${current} → ${newStatus} for task ${id}. ` +
          `Allowed: [${allowed.join(", ")}]`,
      );
    }

    const now = Date.now();
    const result = this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(newStatus, now, id, current);
    return result.changes > 0;
  }

  /** Atomic claim — prevents double-dispatch. Returns true if claimed. */
  claimTask(id: string, runId: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'running', run_id = ?, started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'ready'`,
      )
      .run(runId, now, now, id);
    return result.changes > 0;
  }

  /** Update the run_id on a running task (e.g. after spawnSubagentDirect returns the real runId). */
  updateRunId(id: string, oldRunId: string, newRunId: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        "UPDATE tasks SET run_id = ?, updated_at = ? WHERE id = ? AND status = 'running' AND run_id = ?",
      )
      .run(newRunId, now, id, oldRunId);
    return result.changes > 0;
  }

  /** Idempotent completion — only completes if running with expected runId. */
  completeTask(
    id: string,
    runId: string,
    status: "completed" | "failed",
    result?: unknown,
    error?: string,
  ): boolean {
    const now = Date.now();
    const dbResult = this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, completed_at = ?, result = ?, error = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND run_id = ?`,
      )
      .run(
        status,
        now,
        result !== undefined ? JSON.stringify(result) : null,
        error ?? null,
        now,
        id,
        runId,
      );
    return dbResult.changes > 0;
  }

  /** Update description/metadata of pending tasks (manager plan adjustments). */
  updateTaskDetails(
    id: string,
    updates: { description?: string; metadata?: Record<string, unknown>; priority?: number },
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const params: SqlParam[] = [Date.now()];
    if (updates.description !== undefined) {
      sets.push("description = ?");
      params.push(updates.description);
    }
    if (updates.metadata !== undefined) {
      sets.push("metadata = ?");
      params.push(JSON.stringify(updates.metadata));
    }
    if (updates.priority !== undefined) {
      sets.push("priority = ?");
      params.push(updates.priority);
    }
    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  /** Increment retry count and transition failed → pending with optional scheduled delay. */
  retryTask(id: string): void {
    const task = this.getTask(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    if (task.status !== "failed") {
      throw new Error(`Cannot retry task ${id} in status ${task.status}`);
    }
    if (task.retryCount >= task.maxRetries) {
      throw new Error(`Task ${id} has exhausted retries (${task.retryCount}/${task.maxRetries})`);
    }

    const now = Date.now();
    const newRetryCount = task.retryCount + 1;
    const delay = (task.retryAfterMs ?? 5000) * 2 ** task.retryCount;
    const scheduledAt = now + delay;

    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'pending', retry_count = ?, scheduled_at = ?,
             updated_at = ?, run_id = NULL, started_at = NULL, completed_at = NULL,
             result = NULL, error = NULL
         WHERE id = ? AND status = 'failed'`,
      )
      .run(newRetryCount, scheduledAt, now, id);
  }

  // -------------------------------------------------------------------------
  // Dependencies
  // -------------------------------------------------------------------------

  addDependency(taskId: string, dependsOnTaskId: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
      )
      .run(taskId, dependsOnTaskId);
  }

  removeDependency(taskId: string, dependsOnTaskId: string): void {
    this.db
      .prepare("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?")
      .run(taskId, dependsOnTaskId);
  }

  /** Get task IDs that this task depends on. */
  getDependencies(taskId: string): string[] {
    const rows = this.db
      .prepare("SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?")
      .all(taskId) as Array<{ depends_on_task_id: string }>;
    return rows.map((r) => r.depends_on_task_id);
  }

  /** Get task IDs that depend on this task (blocked by it). */
  getDependents(taskId: string): string[] {
    const rows = this.db
      .prepare("SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?")
      .all(taskId) as Array<{ task_id: string }>;
    return rows.map((r) => r.task_id);
  }

  /** Check if all dependencies of a task are completed. */
  allDepsCompleted(taskId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as cnt FROM task_dependencies td
         JOIN tasks t ON t.id = td.depends_on_task_id
         WHERE td.task_id = ? AND t.status != 'completed'`,
      )
      .get(taskId) as { cnt: number };
    return row.cnt === 0;
  }

  // -------------------------------------------------------------------------
  // Ready tasks
  // -------------------------------------------------------------------------

  /**
   * Get tasks that are ready to dispatch: status = 'ready', optionally filtered by agentId.
   *
   * Also promotes eligible pending/scheduled tasks in a single efficient pass:
   * a task is eligible if it has zero unresolved deps (LEFT JOIN anti-pattern)
   * and its schedule (if any) has been reached.
   */
  getReadyTasks(agentId?: string): TaskRecord[] {
    this.promoteEligibleTasks();

    const agentClause = agentId ? "AND agent_id = ?" : "";
    const params: SqlParam[] = agentId ? [agentId] : [];
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'ready' ${agentClause}
         ORDER BY priority DESC, created_at ASC`,
      )
      .all(...params) as TaskRow[];
    return rows.map((r) => taskFromRow(r));
  }

  /**
   * Promote eligible pending/scheduled tasks to 'ready' in a single SQL pass.
   *
   * A task is eligible when:
   * - status is 'pending' or 'scheduled'
   * - all dependencies are 'completed' (or it has none)
   * - scheduled_at is null or <= now
   *
   * Uses a LEFT JOIN anti-pattern to avoid per-task allDepsCompleted() calls.
   */
  private promoteEligibleTasks(): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE tasks SET status = 'ready', updated_at = ?
         WHERE id IN (
           SELECT t.id FROM tasks t
           LEFT JOIN task_dependencies td ON td.task_id = t.id
           LEFT JOIN tasks dep ON dep.id = td.depends_on_task_id AND dep.status != 'completed'
           WHERE t.status IN ('pending', 'scheduled')
             AND (t.scheduled_at IS NULL OR t.scheduled_at <= ?)
           GROUP BY t.id
           HAVING COUNT(dep.id) = 0
         )`,
      )
      .run(now, now);
  }

  // -------------------------------------------------------------------------
  // Group queries
  // -------------------------------------------------------------------------

  getTasksByGroup(group: string): TaskRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE task_group = ? ORDER BY priority DESC, created_at ASC")
      .all(group) as TaskRow[];
    return rows.map((r) => taskFromRow(r));
  }

  getTasksByObjective(objectiveId: string): TaskRecord[] {
    return this.listTasks({ objectiveId });
  }

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  countRunningTasks(agentId?: string): number {
    if (agentId) {
      const row = this.db
        .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'running' AND agent_id = ?")
        .get(agentId) as { cnt: number };
      return row.cnt;
    }
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'running'")
      .get() as { cnt: number };
    return row.cnt;
  }

  // -------------------------------------------------------------------------
  // Stuck tasks
  // -------------------------------------------------------------------------

  getStuckTasks(timeoutMs: number): TaskRecord[] {
    const cutoff = Date.now() - timeoutMs;
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE status = 'running' AND started_at <= ?
         ORDER BY started_at ASC`,
      )
      .all(cutoff) as TaskRow[];
    return rows.map((r) => taskFromRow(r));
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /** Creates a report and atomically links it to the task. */
  createReport(params: CreateReportParams): string {
    return this.transaction(() => {
      const id = crypto.randomUUID();
      const now = Date.now();

      const task = this.getTask(params.taskId);
      if (!task) {
        throw new Error(`Task ${params.taskId} not found`);
      }

      this.db
        .prepare(
          `INSERT INTO reports (id, task_id, objective_id, agent_id, title, summary, content, format, created_at, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.taskId,
          task.objectiveId,
          task.agentId,
          params.title,
          params.summary,
          params.content,
          params.format ?? "markdown",
          now,
          params.metadata ? JSON.stringify(params.metadata) : null,
        );

      // Atomically link report to task
      this.db
        .prepare("UPDATE tasks SET report_id = ?, updated_at = ? WHERE id = ?")
        .run(id, now, params.taskId);

      return id;
    });
  }

  getReport(id: string): ReportRecord | undefined {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as
      | ReportRow
      | undefined;
    return row ? reportFromRow(row) : undefined;
  }

  getReportByTask(taskId: string): ReportRecord | undefined {
    const row = this.db.prepare("SELECT * FROM reports WHERE task_id = ?").get(taskId) as
      | ReportRow
      | undefined;
    return row ? reportFromRow(row) : undefined;
  }

  getReportsByObjective(objectiveId: string): ReportRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM reports WHERE objective_id = ? ORDER BY created_at ASC")
      .all(objectiveId) as ReportRow[];
    return rows.map(reportFromRow);
  }

  linkReportToTask(reportId: string, taskId: string): void {
    this.db
      .prepare("UPDATE tasks SET report_id = ?, updated_at = ? WHERE id = ?")
      .run(reportId, Date.now(), taskId);
  }

  // -------------------------------------------------------------------------
  // Steps (durable checkpoints)
  // -------------------------------------------------------------------------

  /** Insert a completed step checkpoint. Auto-increments stepIndex based on existing step count. */
  addStep(taskId: string, stepName: string, result?: unknown): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    const stepIndex = this.getStepCount(taskId);

    this.db
      .prepare(
        `INSERT INTO task_steps (id, task_id, step_name, step_index, status, result, created_at, completed_at)
         VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
      )
      .run(
        id,
        taskId,
        stepName,
        stepIndex,
        result !== undefined ? JSON.stringify(result) : null,
        now,
        now,
      );

    return id;
  }

  /** Get all steps for a task ordered by step_index ascending. */
  getSteps(taskId: string): TaskStep[] {
    const rows = this.db
      .prepare("SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_index ASC")
      .all(taskId) as TaskStepRow[];
    return rows.map(stepFromRow);
  }

  /** Count the number of steps recorded for a task. */
  getStepCount(taskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM task_steps WHERE task_id = ?")
      .get(taskId) as { cnt: number };
    return row.cnt;
  }

  // -------------------------------------------------------------------------
  // Events (event bus)
  // -------------------------------------------------------------------------

  /** Insert an event row. Returns the event ID. */
  insertEvent(eventName: string, data?: unknown, expiresAt?: number): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO task_events (id, event_name, data, created_at, consumed_by_task_id, expires_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, eventName, data !== undefined ? JSON.stringify(data) : null, now, expiresAt ?? null);
    return id;
  }

  /** Get an event by ID. */
  getEvent(id: string): TaskEvent | undefined {
    const row = this.db.prepare("SELECT * FROM task_events WHERE id = ?").get(id) as
      | TaskEventRow
      | undefined;
    return row ? eventFromRow(row) : undefined;
  }

  /**
   * Find the first wait condition matching the given event name.
   * If data is provided and the wait condition has a filter, all filter
   * key/value pairs must match the corresponding keys in data.
   */
  findMatchingWait(
    eventName: string,
    data?: unknown,
  ): { waitCondition: WaitCondition; taskId: string } | null {
    const rows = this.db
      .prepare("SELECT * FROM task_wait_conditions WHERE event_name = ? ORDER BY created_at ASC")
      .all(eventName) as WaitConditionRow[];

    for (const row of rows) {
      const wc = waitConditionFromRow(row);

      // If wait condition has a filter, verify data contains all filter keys/values
      if (wc.filter && Object.keys(wc.filter).length > 0) {
        if (!data || typeof data !== "object") {
          continue;
        }
        const dataObj = data as Record<string, unknown>;
        let matches = true;
        for (const [key, value] of Object.entries(wc.filter)) {
          if (dataObj[key] !== value) {
            matches = false;
            break;
          }
        }
        if (!matches) {
          continue;
        }
      }

      return { waitCondition: wc, taskId: wc.taskId };
    }

    return null;
  }

  /** Insert a wait condition for a task. Returns the wait condition ID. */
  insertWaitCondition(
    taskId: string,
    eventName: string,
    filter?: Record<string, unknown>,
    timeoutAt?: number,
  ): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO task_wait_conditions (id, task_id, event_name, filter, timeout_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, eventName, filter ? JSON.stringify(filter) : null, timeoutAt ?? null, now);
    return id;
  }

  /** Remove a wait condition by ID. */
  removeWaitCondition(id: string): void {
    this.db.prepare("DELETE FROM task_wait_conditions WHERE id = ?").run(id);
  }

  /** Find wait conditions that have expired (timeout_at < now). */
  getExpiredWaitConditions(): WaitCondition[] {
    const now = Date.now();
    const rows = this.db
      .prepare("SELECT * FROM task_wait_conditions WHERE timeout_at IS NOT NULL AND timeout_at < ?")
      .all(now) as WaitConditionRow[];
    return rows.map(waitConditionFromRow);
  }

  /** Mark an event as consumed by a task. */
  consumeEvent(eventId: string, taskId: string): void {
    this.db
      .prepare("UPDATE task_events SET consumed_by_task_id = ? WHERE id = ?")
      .run(taskId, eventId);
  }

  /** Get the active wait condition for a task (if any). */
  getWaitConditionForTask(taskId: string): WaitCondition | null {
    const row = this.db
      .prepare("SELECT * FROM task_wait_conditions WHERE task_id = ? LIMIT 1")
      .get(taskId) as WaitConditionRow | undefined;
    return row ? waitConditionFromRow(row) : null;
  }
}
