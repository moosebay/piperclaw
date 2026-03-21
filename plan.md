# Task-Driven Agent System — Implementation Plan

## Overview

Transform the agent system to be **task-driven**: a central task queue (SQLite) where tasks can be created, scheduled, dependency-blocked, and auto-dispatched to sub-agents. Skills can create tasks that trigger other skills/agents. The system is event-based — when a task becomes ready (deps resolved + schedule reached), a sub-agent is automatically spawned.

Tasks support both **parallel** and **sequential** execution:
- **Parallel:** tasks with no mutual dependencies are dispatched simultaneously
- **Sequential:** tasks that depend on prior tasks wait for completion
- **Fan-out/fan-in:** parallel batch → gate task → another parallel batch

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│  Agent/Skill │────>│  Task Store  │────>│  Task Dispatcher  │
│  (creates)   │     │  (SQLite)    │     │  (watches/polls)  │
└─────────────┘     └──────────────┘     └──────────────────┘
                          │                       │
                          │  task_ready event      │  auto-spawn (parallel or sequential)
                          ▼                       ▼
                    ┌──────────────┐     ┌──────────────────┐
                    │  Hook System │     │  Subagent Spawn   │
                    │  (notify)    │     │  (existing infra) │
                    └──────────────┘     └──────────────────┘
                                                │
                                                │  on completion
                                                ▼
                                        ┌──────────────────┐
                                        │  Dep Resolution   │
                                        │  (unblock next)   │
                                        └──────────────────┘
```

### Execution Modes

```
Parallel:    A, B, C (no mutual deps) → all dispatched at once
Sequential:  A → B → C (each depends on previous)
Fan-out/in:  A → [B, C, D] → E (E depends on B,C,D; B,C,D depend on A)
```

The dispatcher spawns multiple sub-agents concurrently for parallel tasks, respecting a configurable `maxConcurrent` limit per agent.

---

## Step-by-Step Implementation

### Step 1: Task Types & Interfaces

**New file: `src/tasks/types.ts`**

```typescript
type TaskStatus = 'pending' | 'scheduled' | 'ready' | 'running' | 'completed' | 'failed' | 'cancelled';

type TaskRecord = {
  id: string;
  agentId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: number;
  group?: string;              // named batch for managing related tasks as a unit
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
  dependsOn?: string[];        // task IDs this depends on
  dependents?: string[];       // task IDs that depend on this
  maxConcurrent?: number;      // override per-task concurrency limit
};

type CreateTaskParams = {
  agentId: string;
  title: string;
  description?: string;
  priority?: number;
  group?: string;
  scheduledAt?: number;        // ms timestamp — don't run before this
  assignedAgentId?: string;
  assignedSkill?: string;
  dependsOn?: string[];        // task IDs — blocked until all complete
  metadata?: Record<string, unknown>;
  createdBySession?: string;
};
```

### Step 2: Task Store (SQLite)

**New file: `src/tasks/task-store.ts`**

SQLite-backed task store using `node:sqlite` (same pattern as `src/memory/sqlite.ts`).

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
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
  result TEXT,                   -- JSON
  error TEXT,
  metadata TEXT                  -- JSON
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_scheduled ON tasks(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(task_group);
```

**Key operations:**
- `createTask(params)` → task ID
- `updateTaskStatus(id, status)`
- `addDependency(taskId, dependsOnTaskId)`
- `getReadyTasks(agentId?)` → tasks where: status=pending/scheduled, all deps completed, scheduledAt <= now (or null)
- `getTask(id)` / `listTasks(filter)`
- `markCompleted(id, result?)` / `markFailed(id, error)`
- `getDependents(taskId)` → tasks blocked by this one
- `getTasksByGroup(group)` → all tasks in a named batch
- `countRunningTasks(agentId)` → for concurrency enforcement

**DB location:** `~/.openclaw/state/tasks.sqlite`

### Step 3: Dependency Resolution

**New file: `src/tasks/task-deps.ts`**

When a task completes:
1. Query all dependents via `task_dependencies`
2. For each dependent, check if ALL its dependencies are now `completed`
3. If yes AND `scheduledAt` is met (or null) → transition to `ready`
4. Nudge the dispatcher to pick up newly ready tasks immediately

Cascading: completing task A may unblock B and C (parallel), which may later unblock D.

### Step 4: Task Dispatcher

**New file: `src/tasks/task-dispatcher.ts`**

Timer-based loop (5s default) + immediate nudge on task create/complete:

1. Query store for `ready` tasks, ordered by priority desc
2. Check concurrency: `countRunningTasks(agentId)` vs `maxConcurrent` (default configurable)
3. For each task within the concurrency limit, spawn a sub-agent via `spawnSubagentDirect`
4. Transition task to `running`, store the `runId`
5. **Parallel dispatch:** multiple ready tasks with no mutual deps are spawned in the same tick
6. **Sequential enforcement:** tasks with unresolved deps stay blocked — only dispatched after predecessors complete

**Concurrency control:**
- Global default: `tasks.maxConcurrent` config (e.g., 3)
- Per-agent override: `agents.list[].tasks.maxConcurrent`
- Per-task override: `maxConcurrent` field on task record

### Step 5: Hook Integration

**Modify: `src/plugins/types.ts`** — New hook event types:
- `task_created` — when a new task is created
- `task_ready` — when a task becomes ready (all blockers cleared)
- `task_completed` — when a task finishes successfully
- `task_failed` — when a task fails

**Modify: `src/plugins/hooks.ts`** — Register hook runners for new hooks.

**Integrate with `subagent_ended`:** When a subagent completes, check if its `runId` matches any task. If so → mark completed/failed → trigger dependency resolution → nudge dispatcher.

### Step 6: Task Service

**New file: `src/tasks/task-service.ts`**

Service lifecycle wrapper (similar to cron service pattern):
- `startTaskService(state)` — init SQLite store, start dispatcher timer
- `stopTaskService()` — stop timer, flush pending state
- `nudgeDispatcher()` — immediate re-check (called after task create/complete)

**Modify: gateway startup** — Start task service alongside cron service.

### Step 7: Agent Tool (tasks)

**New file: `src/agents/tools/tasks-tool.ts`**

Agent-facing tool `tasks` with actions:
- `create` — create task with optional deps, schedule, skill, group
- `list` — filter by status, agent, group
- `get` — task details by ID
- `cancel` — cancel pending/scheduled task
- `update` — update metadata/description

This is how agents and skills create tasks for other agents/skills.

### Step 8: Skill-to-Skill via Tasks

When a skill creates a task with `assignedSkill`:
- Dispatcher spawns sub-agent with that skill loaded in context
- Sub-agent prompt includes task description + skill instructions
- On completion, skill output becomes task result
- Downstream dependent tasks unblock

**Chain example:**
1. Skill A creates tasks: `[analyze-data, fetch-sources]` (parallel, no deps)
2. Skill A creates task: `generate-report` (depends on both above, assignedSkill: "report-gen")
3. Dispatcher spawns agents for `analyze-data` + `fetch-sources` simultaneously
4. Both complete → `generate-report` unblocks → dispatcher spawns agent with `report-gen` skill

### Step 9: CLI Commands

**New file: `src/commands/tasks.ts`**

- `openclaw tasks list [--status=...] [--agent=...] [--group=...]`
- `openclaw tasks create <title> [--schedule=...] [--depends-on=...] [--agent=...] [--skill=...] [--group=...]`
- `openclaw tasks get <id>`
- `openclaw tasks cancel <id>`

---

## File Summary

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/tasks/types.ts` | Task type definitions |
| Create | `src/tasks/task-store.ts` | SQLite-backed task persistence |
| Create | `src/tasks/task-deps.ts` | Dependency resolution logic |
| Create | `src/tasks/task-dispatcher.ts` | Timer + event dispatcher loop |
| Create | `src/tasks/task-service.ts` | Service lifecycle (start/stop) |
| Create | `src/agents/tools/tasks-tool.ts` | Agent-facing task tool |
| Create | `src/commands/tasks.ts` | CLI commands for tasks |
| Modify | `src/plugins/types.ts` | Add task hook types |
| Modify | `src/plugins/hooks.ts` | Register task hook runners |
| Modify | `src/agents/subagent-registry-completion.ts` | Link subagent completion → task completion |
| Modify | Gateway startup | Start task service |
| Create | `src/tasks/task-store.test.ts` | Tests for store |
| Create | `src/tasks/task-deps.test.ts` | Tests for dependency resolution |
| Create | `src/tasks/task-dispatcher.test.ts` | Tests for dispatcher |

---

## Key Design Decisions

1. **SQLite via `node:sqlite`** — Same pattern as memory system. DB at `~/.openclaw/state/tasks.sqlite`.
2. **Hybrid scheduling** — Timer poll (5s) + event-driven nudge on create/complete. Not pure polling.
3. **Parallel + sequential** — Tasks with no mutual deps dispatch simultaneously; deps enforce ordering. Fan-out/fan-in supported via dependency graph.
4. **Concurrency limits** — Global, per-agent, and per-task `maxConcurrent` settings control how many tasks run in parallel.
5. **Task groups** — Named batches for managing related tasks as a unit.
6. **Reuse existing spawn infra** — Tasks spawn sub-agents via `spawnSubagentDirect`, inheriting subagent lifecycle (timeout, cleanup, announcements).
7. **Hook-based extensibility** — Plugins react to `task_created`, `task_ready`, `task_completed`, `task_failed`.
8. **Skill chaining via tasks** — Skills create tasks with `assignedSkill`; dispatcher handles the rest. No direct skill-to-skill invocation.
9. **Dependency graph** — Simple DAG via `task_dependencies` table. Cascading resolution on completion.
