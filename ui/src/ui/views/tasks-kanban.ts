import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { TaskItem, TasksState, TaskDetail } from "../controllers/tasks.ts";

export type TasksKanbanProps = {
  state: TasksState;
  connected: boolean;
  onSelectTask: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRefresh: () => void;
  onStatusFilter: (status: string) => void;
  onSkillFilter: (skill: string) => void;
  onObjectiveFilter: (id: string | null) => void;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type KanbanColumn = { key: string; label: string; color: string };

const COLUMNS: KanbanColumn[] = [
  { key: "pending", label: "Pending", color: "#6b7280" },
  { key: "ready", label: "Ready", color: "#3b82f6" },
  { key: "running", label: "Running", color: "#f59e0b" },
  { key: "waiting", label: "Waiting", color: "#8b5cf6" },
  { key: "completed", label: "Completed", color: "#22c55e" },
  { key: "failed", label: "Failed", color: "#ef4444" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectUniqueSkills(tasks: TaskItem[]): string[] {
  const set = new Set<string>();
  for (const task of tasks) {
    if (task.assignedSkill) {
      set.add(task.assignedSkill);
    }
  }
  return Array.from(set).toSorted((a, b) => a.localeCompare(b));
}

function collectUniqueObjectiveIds(tasks: TaskItem[]): string[] {
  const set = new Set<string>();
  for (const task of tasks) {
    if (task.objectiveId) {
      set.add(task.objectiveId);
    }
  }
  return Array.from(set).toSorted((a, b) => a.localeCompare(b));
}

function filterTasks(tasks: TaskItem[], state: TasksState): TaskItem[] {
  return tasks.filter((task) => {
    if (state.taskStatusFilter !== "all" && task.status !== state.taskStatusFilter) {
      return false;
    }
    if (state.taskSkillFilter !== "all" && task.assignedSkill !== state.taskSkillFilter) {
      return false;
    }
    if (state.selectedObjectiveId && task.objectiveId !== state.selectedObjectiveId) {
      return false;
    }
    return true;
  });
}

function tasksForColumn(tasks: TaskItem[], columnKey: string): TaskItem[] {
  return tasks
    .filter((task) => task.status === columnKey)
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function renderFilters(props: TasksKanbanProps) {
  const skills = collectUniqueSkills(props.state.tasks);
  const objectiveIds = collectUniqueObjectiveIds(props.state.tasks);

  return html`
    <div class="filters" style="margin-bottom:14px">
      <label class="field" style="min-width:130px">
        <span style="font-size:11px">Status</span>
        <select
          .value=${props.state.taskStatusFilter}
          @change=${(e: Event) =>
            props.onStatusFilter((e.target as HTMLSelectElement).value)}
        >
          <option value="all">All statuses</option>
          ${COLUMNS.map(
            (col) => html`<option value=${col.key}>${col.label}</option>`,
          )}
          <option value="cancelled">Cancelled</option>
        </select>
      </label>

      <label class="field" style="min-width:130px">
        <span style="font-size:11px">Skill</span>
        <select
          .value=${props.state.taskSkillFilter}
          @change=${(e: Event) =>
            props.onSkillFilter((e.target as HTMLSelectElement).value)}
        >
          <option value="all">All skills</option>
          ${skills.map(
            (skill) => html`<option value=${skill}>${skill}</option>`,
          )}
        </select>
      </label>

      ${objectiveIds.length > 1
        ? html`
            <label class="field" style="min-width:130px">
              <span style="font-size:11px">Objective</span>
              <select
                .value=${props.state.selectedObjectiveId ?? ""}
                @change=${(e: Event) => {
                  const val = (e.target as HTMLSelectElement).value;
                  props.onObjectiveFilter(val || null);
                }}
              >
                <option value="">All objectives</option>
                ${objectiveIds.map(
                  (id) => html`<option value=${id}>${id.slice(0, 8)}...</option>`,
                )}
              </select>
            </label>
          `
        : nothing}

      <button
        class="btn"
        ?disabled=${props.state.tasksLoading}
        @click=${props.onRefresh}
      >
        ${props.state.tasksLoading ? "Loading..." : "Refresh"}
      </button>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Kanban card
// ---------------------------------------------------------------------------

function renderTaskCard(
  task: TaskItem,
  selected: boolean,
  onSelect: (id: string) => void,
) {
  return html`
    <div
      class="list-item${selected ? " list-item-selected" : ""} list-item-clickable"
      style="
        padding:10px 12px;
        margin-bottom:6px;
        border-radius:var(--radius-md);
        cursor:pointer;
      "
      @click=${() => onSelect(task.id)}
    >
      <div
        style="
          font-size:13px;
          color:var(--text);
          white-space:nowrap;
          overflow:hidden;
          text-overflow:ellipsis;
        "
      >
        ${task.title}
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:4px;display:flex;flex-wrap:wrap;gap:4px 10px">
        <span>${formatRelativeTimestamp(task.updatedAt)}</span>
        ${task.assignedSkill
          ? html`
              <span
                style="
                  background:var(--bg-muted);
                  padding:1px 6px;
                  border-radius:4px;
                  font-size:10px;
                "
              >
                ${task.assignedSkill}
              </span>
            `
          : nothing}
      </div>
      ${task.error
        ? html`
            <div
              style="
                font-size:11px;
                color:#ef4444;
                margin-top:4px;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
              "
            >
              ${task.error}
            </div>
          `
        : nothing}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Kanban column
// ---------------------------------------------------------------------------

function renderColumn(
  col: KanbanColumn,
  tasks: TaskItem[],
  selectedTaskId: string | null,
  onSelect: (id: string) => void,
) {
  return html`
    <div
      style="
        min-width:0;
        display:flex;
        flex-direction:column;
        background:var(--bg-accent);
        border-radius:var(--radius-lg);
        border:1px solid var(--border);
        overflow:hidden;
      "
    >
      <div
        style="
          padding:10px 14px;
          display:flex;
          align-items:center;
          gap:8px;
          border-bottom:1px solid var(--border);
        "
      >
        <span
          style="
            display:inline-block;
            width:10px;
            height:10px;
            border-radius:50%;
            background:${col.color};
          "
        ></span>
        <span style="font-size:13px;font-weight:600;color:var(--text-strong)">${col.label}</span>
        <span
          style="
            font-size:11px;
            color:var(--muted);
            background:var(--bg-muted);
            padding:1px 7px;
            border-radius:9999px;
          "
        >
          ${tasks.length}
        </span>
      </div>
      <div
        style="
          padding:8px;
          flex:1;
          overflow-y:auto;
          max-height:520px;
        "
      >
        ${tasks.length === 0
          ? html`
              <div style="text-align:center;color:var(--muted);font-size:12px;padding:16px 0">
                No tasks
              </div>
            `
          : tasks.map((task) =>
              renderTaskCard(task, task.id === selectedTaskId, onSelect),
            )}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function renderDetailPanel(
  detail: TaskDetail,
  loading: boolean,
  onApprove: (id: string) => void,
  onReject: (id: string) => void,
) {
  const { task, report, steps, waitCondition } = detail;
  const isWaiting = task.status === "waiting";

  return html`
    <div class="card" style="margin-top:16px">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div class="card-title">${task.title}</div>
          ${task.description
            ? html`<div class="card-sub">${task.description}</div>`
            : nothing}
        </div>
        ${isWaiting
          ? html`
              <div class="row" style="gap:6px;flex-shrink:0">
                <button
                  class="btn primary"
                  style="font-size:12px;padding:4px 12px"
                  @click=${() => onApprove(task.id)}
                >
                  Approve
                </button>
                <button
                  class="btn danger"
                  style="font-size:12px;padding:4px 12px"
                  @click=${() => onReject(task.id)}
                >
                  Reject
                </button>
              </div>
            `
          : nothing}
      </div>

      <div
        style="
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));
          gap:10px;
          margin-top:14px;
          font-size:12px;
        "
      >
        <div>
          <div style="color:var(--muted)">Status</div>
          <div style="color:var(--text);margin-top:2px">${task.status}</div>
        </div>
        <div>
          <div style="color:var(--muted)">Priority</div>
          <div style="color:var(--text);margin-top:2px">${task.priority}</div>
        </div>
        <div>
          <div style="color:var(--muted)">Skill</div>
          <div style="color:var(--text);margin-top:2px">${task.assignedSkill ?? "none"}</div>
        </div>
        <div>
          <div style="color:var(--muted)">Trigger</div>
          <div style="color:var(--text);margin-top:2px">${task.managerTrigger}</div>
        </div>
        <div>
          <div style="color:var(--muted)">Retries</div>
          <div style="color:var(--text);margin-top:2px">${task.retryCount} / ${task.maxRetries}</div>
        </div>
        <div>
          <div style="color:var(--muted)">Updated</div>
          <div style="color:var(--text);margin-top:2px">${formatRelativeTimestamp(task.updatedAt)}</div>
        </div>
      </div>

      ${task.dependsOn && task.dependsOn.length > 0
        ? html`
            <div style="margin-top:12px">
              <div style="font-size:12px;color:var(--muted);margin-bottom:4px">Dependencies</div>
              <div style="display:flex;flex-wrap:wrap;gap:4px">
                ${task.dependsOn.map(
                  (dep) => html`
                    <span
                      style="
                        background:var(--bg-muted);
                        padding:2px 8px;
                        border-radius:4px;
                        font-size:11px;
                        color:var(--text);
                        font-family:monospace;
                      "
                    >
                      ${dep.slice(0, 8)}
                    </span>
                  `,
                )}
              </div>
            </div>
          `
        : nothing}

      ${task.error
        ? html`
            <div class="callout danger" style="margin-top:12px;font-size:12px">
              ${task.error}
            </div>
          `
        : nothing}

      ${waitCondition
        ? html`
            <div
              style="
                margin-top:12px;
                padding:10px 14px;
                border-radius:var(--radius-md);
                border:1px solid #8b5cf644;
                background:#8b5cf60a;
                font-size:12px;
              "
            >
              <div style="color:#8b5cf6;font-weight:600;margin-bottom:4px">Waiting for event</div>
              <div style="color:var(--text)">${waitCondition.eventName}</div>
              ${waitCondition.timeoutAt
                ? html`
                    <div style="color:var(--muted);margin-top:2px">
                      Timeout: ${new Date(waitCondition.timeoutAt).toLocaleString()}
                    </div>
                  `
                : nothing}
            </div>
          `
        : nothing}

      ${renderSteps(steps)}
      ${renderReportSummary(report)}

      ${loading
        ? html`<div class="muted" style="margin-top:12px;font-size:12px">Loading details...</div>`
        : nothing}
    </div>
  `;
}

function renderSteps(steps: TaskDetail["steps"]) {
  if (steps.length === 0) {
    return nothing;
  }

  const sorted = steps.toSorted((a, b) => a.stepIndex - b.stepIndex);

  return html`
    <div style="margin-top:14px">
      <div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px">Steps</div>
      <div class="list" style="gap:2px">
        ${sorted.map(
          (step) => html`
            <div class="list-item" style="padding:6px 10px;display:flex;align-items:center;gap:8px">
              <span
                style="
                  display:inline-block;
                  width:7px;
                  height:7px;
                  border-radius:50%;
                  background:${stepStatusColor(step.status)};
                  flex-shrink:0;
                "
              ></span>
              <span style="font-size:12px;color:var(--text);flex:1;min-width:0">${step.stepName}</span>
              <span style="font-size:11px;color:var(--muted)">${step.status}</span>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

function stepStatusColor(status: string): string {
  if (status === "completed" || status === "done") return "#22c55e";
  if (status === "running" || status === "in_progress") return "#f59e0b";
  if (status === "failed" || status === "error") return "#ef4444";
  return "#6b7280";
}

function renderReportSummary(report: TaskDetail["report"]) {
  if (!report) {
    return nothing;
  }

  return html`
    <div style="margin-top:14px">
      <div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:6px">Report</div>
      <div
        style="
          padding:10px 14px;
          border-radius:var(--radius-md);
          background:var(--bg-accent);
          border:1px solid var(--border);
          font-size:12px;
        "
      >
        <div style="font-weight:600;color:var(--text-strong)">${report.title}</div>
        <div style="color:var(--text);margin-top:4px;line-height:1.5">${report.summary}</div>
        <div style="color:var(--muted);margin-top:6px;font-size:11px">
          ${formatRelativeTimestamp(report.createdAt)}
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderTasksKanban(props: TasksKanbanProps) {
  const { state, onSelectTask, onApprove, onReject } = props;
  const filtered = filterTasks(state.tasks, state);

  // Determine which columns to show based on status filter
  const visibleColumns =
    state.taskStatusFilter === "all"
      ? COLUMNS
      : COLUMNS.filter((col) => col.key === state.taskStatusFilter);

  return html`
    <section>
      <div class="row" style="justify-content:space-between;margin-bottom:12px">
        <div>
          <div class="card-title" style="font-size:17px">Tasks</div>
          <div class="card-sub">Kanban view of all tasks.</div>
        </div>
      </div>

      ${renderFilters(props)}

      ${state.tasksError
        ? html`<div class="callout danger" style="margin-bottom:14px">${state.tasksError}</div>`
        : nothing}

      <div
        style="
          display:grid;
          grid-template-columns:repeat(${visibleColumns.length}, minmax(0, 1fr));
          gap:12px;
          overflow-x:auto;
        "
      >
        ${visibleColumns.map((col) =>
          renderColumn(
            col,
            tasksForColumn(filtered, col.key),
            state.selectedTaskId,
            onSelectTask,
          ),
        )}
      </div>

      ${state.taskDetail && state.selectedTaskId
        ? renderDetailPanel(state.taskDetail, state.taskDetailLoading, onApprove, onReject)
        : nothing}
    </section>
  `;
}
