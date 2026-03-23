import { html, nothing } from "lit";
import { formatRelativeTimestamp } from "../format.ts";
import type { TaskObjective, TaskItem, TasksState } from "../controllers/tasks.ts";

export type ObjectivesProps = {
  state: TasksState;
  connected: boolean;
  onSelectObjective: (id: string | null) => void;
  onCancelObjective: (id: string) => void;
  onRefresh: () => void;
};

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  pending: "#6b7280",
  scheduled: "#6b7280",
  ready: "#3b82f6",
  running: "#f59e0b",
  waiting: "#8b5cf6",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#9ca3af",
  active: "#3b82f6",
};

function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? "#6b7280";
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Returns true if the objective is still actionable. */
function isActiveObjective(obj: TaskObjective): boolean {
  return !["completed", "cancelled", "failed"].includes(obj.status);
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

type ProgressSegment = { key: string; count: number; color: string; label: string };

function buildProgressSegments(
  progress: NonNullable<TaskObjective["progress"]>,
): ProgressSegment[] {
  // Order matters: left-to-right visual flow
  return [
    { key: "completed", count: progress.completed, color: "#22c55e", label: "Completed" },
    { key: "running", count: progress.running, color: "#f59e0b", label: "Running" },
    { key: "waiting", count: progress.waiting, color: "#8b5cf6", label: "Waiting" },
    { key: "ready", count: progress.ready, color: "#3b82f6", label: "Ready" },
    { key: "scheduled", count: progress.scheduled, color: "#64748b", label: "Scheduled" },
    { key: "failed", count: progress.failed, color: "#ef4444", label: "Failed" },
    { key: "cancelled", count: progress.cancelled, color: "#9ca3af", label: "Cancelled" },
    { key: "pending", count: progress.pending, color: "#6b7280", label: "Pending" },
  ].filter((seg) => seg.count > 0);
}

function renderProgressBar(progress: NonNullable<TaskObjective["progress"]>) {
  const total = progress.total || 1;
  const segments = buildProgressSegments(progress);

  return html`
    <div style="margin-top:10px">
      <div
        style="
          display:flex;
          height:6px;
          border-radius:3px;
          overflow:hidden;
          background:var(--bg-muted);
        "
      >
        ${segments.map(
          (seg) => html`
            <div
              style="
                width:${(seg.count / total) * 100}%;
                background:${seg.color};
                transition:width 0.3s ease;
              "
              title="${seg.label}: ${seg.count}"
            ></div>
          `,
        )}
      </div>
      <div
        style="
          display:flex;
          flex-wrap:wrap;
          gap:8px 14px;
          margin-top:6px;
          font-size:11px;
          color:var(--muted);
        "
      >
        ${segments.map(
          (seg) => html`
            <span style="display:inline-flex;align-items:center;gap:4px">
              <span
                style="
                  display:inline-block;
                  width:8px;
                  height:8px;
                  border-radius:50%;
                  background:${seg.color};
                "
              ></span>
              ${seg.label} ${seg.count}
            </span>
          `,
        )}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Task tree within an objective
// ---------------------------------------------------------------------------

function renderTaskTree(tasks: TaskItem[], objectiveId: string) {
  const objTasks = tasks
    .filter((task) => task.objectiveId === objectiveId)
    .toSorted((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);

  if (objTasks.length === 0) {
    return html`<div class="muted" style="margin-top:10px;font-size:13px">No tasks yet.</div>`;
  }

  // Group by group field (undefined groups go under "Ungrouped")
  const groups = new Map<string, TaskItem[]>();
  for (const task of objTasks) {
    const groupName = task.group ?? "Ungrouped";
    const bucket = groups.get(groupName);
    if (bucket) {
      bucket.push(task);
    } else {
      groups.set(groupName, [task]);
    }
  }

  const singleGroup = groups.size === 1 && groups.has("Ungrouped");

  return html`
    <div style="margin-top:10px">
      ${singleGroup
        ? renderTaskList(objTasks)
        : html`${Array.from(groups.entries()).map(
            ([groupName, groupTasks]) => html`
              <div style="margin-top:8px">
                <div
                  style="
                    font-size:12px;
                    font-weight:600;
                    color:var(--muted);
                    text-transform:uppercase;
                    letter-spacing:0.04em;
                    margin-bottom:4px;
                  "
                >
                  ${groupName}
                </div>
                ${renderTaskList(groupTasks)}
              </div>
            `,
          )}`}
    </div>
  `;
}

function renderTaskList(tasks: TaskItem[]) {
  return html`
    <div class="list" style="gap:2px">
      ${tasks.map(
        (task) => html`
          <div
            class="list-item"
            style="
              padding:8px 12px;
              display:flex;
              align-items:center;
              gap:10px;
            "
          >
            <span
              style="
                display:inline-block;
                width:8px;
                height:8px;
                border-radius:50%;
                background:${statusColor(task.status)};
                flex-shrink:0;
              "
            ></span>
            <div style="flex:1;min-width:0">
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
              <div style="font-size:11px;color:var(--muted);margin-top:2px">
                ${statusLabel(task.status)}
                ${task.assignedSkill ? html` · ${task.assignedSkill}` : nothing}
                ${task.error
                  ? html` · <span style="color:#ef4444">${task.error}</span>`
                  : nothing}
              </div>
            </div>
            <div style="font-size:11px;color:var(--muted);flex-shrink:0">
              ${formatRelativeTimestamp(task.updatedAt)}
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Objective card
// ---------------------------------------------------------------------------

function renderObjectiveCard(
  obj: TaskObjective,
  expanded: boolean,
  tasks: TaskItem[],
  onSelect: (id: string | null) => void,
  onCancel: (id: string) => void,
) {
  const active = isActiveObjective(obj);

  return html`
    <div class="card" style="cursor:pointer" @click=${() => onSelect(expanded ? null : obj.id)}>
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div class="card-title" style="display:flex;align-items:center;gap:8px">
            <span>${obj.title}</span>
            <span
              style="
                display:inline-block;
                font-size:11px;
                font-weight:500;
                padding:2px 8px;
                border-radius:9999px;
                background:${statusColor(obj.status)}22;
                color:${statusColor(obj.status)};
                border:1px solid ${statusColor(obj.status)}44;
              "
            >
              ${statusLabel(obj.status)}
            </span>
          </div>
          <div class="card-sub" style="margin-top:4px">
            ${obj.description}
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">
            Priority ${obj.priority} · proposed by ${obj.proposedBy} ·
            ${formatRelativeTimestamp(obj.createdAt)}
          </div>
        </div>
        <div class="row" style="gap:6px;flex-shrink:0" @click=${(e: Event) => e.stopPropagation()}>
          ${active
            ? html`
                <button
                  class="btn danger"
                  style="font-size:12px;padding:4px 10px"
                  @click=${() => onCancel(obj.id)}
                >
                  Cancel
                </button>
              `
            : nothing}
          <span
            style="
              font-size:18px;
              color:var(--muted);
              transition:transform 0.2s ease;
              transform:rotate(${expanded ? "180" : "0"}deg);
              user-select:none;
            "
          >
            &#x25BC;
          </span>
        </div>
      </div>
      ${obj.progress ? renderProgressBar(obj.progress) : nothing}
      ${expanded ? renderTaskTree(tasks, obj.id) : nothing}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderObjectives(props: ObjectivesProps) {
  const { state, onSelectObjective, onCancelObjective, onRefresh } = props;

  return html`
    <section>
      <div class="row" style="justify-content:space-between;margin-bottom:16px">
        <div>
          <div class="card-title" style="font-size:17px">Objectives</div>
          <div class="card-sub">Task objectives and their progress.</div>
        </div>
        <button
          class="btn"
          ?disabled=${state.objectivesLoading}
          @click=${onRefresh}
        >
          ${state.objectivesLoading ? "Loading..." : "Refresh"}
        </button>
      </div>

      ${state.objectivesError
        ? html`<div class="callout danger" style="margin-bottom:14px">
            ${state.objectivesError}
          </div>`
        : nothing}

      ${state.objectives.length === 0 && !state.objectivesLoading
        ? html`<div class="muted" style="padding:24px 0;text-align:center">
            No objectives found.
          </div>`
        : nothing}

      <div class="stack" style="gap:14px">
        ${state.objectives.map((obj) =>
          renderObjectiveCard(
            obj,
            state.selectedObjectiveId === obj.id,
            state.tasks,
            onSelectObjective,
            onCancelObjective,
          ),
        )}
      </div>
    </section>
  `;
}
