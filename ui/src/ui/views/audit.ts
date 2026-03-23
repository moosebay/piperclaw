import { html, nothing } from "lit";
import type { AuditEntry, TasksState } from "../controllers/tasks.ts";

export type AuditProps = {
  state: TasksState;
  connected: boolean;
  onFilterChange: (filter: string) => void;
  onRefresh: () => void;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTION_COLORS: Record<string, string> = {
  created: "#3b82f6",
  approved: "#22c55e",
  rejected: "#ef4444",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#9ca3af",
  started: "#f59e0b",
  retried: "#f59e0b",
  scheduled: "#6b7280",
  waiting: "#8b5cf6",
  status_change: "#8b5cf6",
};

function actionColor(action: string): string {
  // Check for exact match first, then try partial match
  if (ACTION_COLORS[action]) {
    return ACTION_COLORS[action];
  }
  const lower = action.toLowerCase();
  for (const [key, color] of Object.entries(ACTION_COLORS)) {
    if (lower.includes(key)) {
      return color;
    }
  }
  return "#6b7280";
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;

  // If less than 24h ago, show time only
  if (diff < 86_400_000) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  // Otherwise show date + time
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function matchesFilter(entry: AuditEntry, filter: string): boolean {
  if (!filter) {
    return true;
  }
  const lower = filter.toLowerCase();
  return (
    entry.action.toLowerCase().includes(lower) ||
    entry.entityType.toLowerCase().includes(lower) ||
    entry.entityId.toLowerCase().includes(lower) ||
    (entry.actor?.toLowerCase().includes(lower) ?? false) ||
    (entry.detail?.toLowerCase().includes(lower) ?? false) ||
    (entry.fromStatus?.toLowerCase().includes(lower) ?? false) ||
    (entry.toStatus?.toLowerCase().includes(lower) ?? false)
  );
}

// ---------------------------------------------------------------------------
// Transition arrow
// ---------------------------------------------------------------------------

function renderTransition(from?: string, to?: string) {
  if (!from && !to) {
    return nothing;
  }

  return html`
    <span style="display:inline-flex;align-items:center;gap:4px;font-size:12px">
      ${from ? html`<span style="color:var(--muted)">${from}</span>` : nothing}
      ${
        from && to
          ? html`
              <span style="color: var(--muted)">&rarr;</span>
            `
          : nothing
      }
      ${to ? html`<span style="color:var(--text)">${to}</span>` : nothing}
    </span>
  `;
}

// ---------------------------------------------------------------------------
// Table rows
// ---------------------------------------------------------------------------

function renderAuditRow(entry: AuditEntry) {
  return html`
    <tr
      style="
        border-bottom:1px solid var(--border);
        transition:background 0.15s ease;
      "
      @mouseenter=${(e: Event) => {
        (e.currentTarget as HTMLElement).style.background = "var(--bg-hover)";
      }}
      @mouseleave=${(e: Event) => {
        (e.currentTarget as HTMLElement).style.background = "";
      }}
    >
      <td style="padding:8px 12px;font-size:12px;color:var(--muted);white-space:nowrap">
        ${formatTimestamp(entry.createdAt)}
      </td>
      <td style="padding:8px 12px;font-size:12px">
        <span style="color:var(--muted)">${entry.entityType}</span>
        <span
          style="
            color:var(--text);
            font-family:monospace;
            font-size:11px;
            margin-left:4px;
          "
        >
          ${entry.entityId.slice(0, 8)}
        </span>
      </td>
      <td style="padding:8px 12px">
        <span
          style="
            display:inline-block;
            font-size:11px;
            font-weight:500;
            padding:2px 8px;
            border-radius:9999px;
            background:${actionColor(entry.action)}18;
            color:${actionColor(entry.action)};
            border:1px solid ${actionColor(entry.action)}30;
          "
        >
          ${entry.action}
        </span>
      </td>
      <td style="padding:8px 12px">
        ${renderTransition(entry.fromStatus, entry.toStatus)}
      </td>
      <td style="padding:8px 12px;font-size:12px;color:var(--text)">
        ${
          entry.actor ??
          html`
            <span style="color: var(--muted)">system</span>
          `
        }
      </td>
      <td
        style="
          padding:8px 12px;
          font-size:12px;
          color:var(--muted);
          max-width:260px;
          white-space:nowrap;
          overflow:hidden;
          text-overflow:ellipsis;
        "
        title=${entry.detail ?? ""}
      >
        ${entry.detail ?? ""}
      </td>
    </tr>
  `;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderAudit(props: AuditProps) {
  const { state, onFilterChange, onRefresh } = props;
  const filtered = state.auditLog.filter((entry) => matchesFilter(entry, state.auditFilter));
  // Sort newest first
  const sorted = filtered.toSorted((a, b) => b.createdAt - a.createdAt);

  return html`
    <section>
      <div class="row" style="justify-content:space-between;margin-bottom:16px">
        <div>
          <div class="card-title" style="font-size:17px">Audit Log</div>
          <div class="card-sub">Task and objective lifecycle events.</div>
        </div>
        <button
          class="btn"
          ?disabled=${state.auditLoading}
          @click=${onRefresh}
        >
          ${state.auditLoading ? "Loading..." : "Refresh"}
        </button>
      </div>

      <div class="filters" style="margin-bottom:14px">
        <label class="field" style="min-width:200px;flex:1;max-width:360px">
          <span style="font-size:11px">Filter</span>
          <input
            type="text"
            placeholder="Search actions, entities, actors..."
            .value=${state.auditFilter}
            @input=${(e: Event) => onFilterChange((e.target as HTMLInputElement).value)}
          />
        </label>
        <div style="font-size:12px;color:var(--muted)">
          ${sorted.length}${
            sorted.length !== state.auditLog.length ? html` of ${state.auditLog.length}` : nothing
          }
          entries
        </div>
      </div>

      ${
        sorted.length === 0 && !state.auditLoading
          ? html`
            <div class="muted" style="padding:24px 0;text-align:center">
              ${state.auditFilter ? "No matching entries." : "No audit entries found."}
            </div>
          `
          : nothing
      }

      ${
        sorted.length > 0
          ? html`
            <div
              style="
                overflow-x:auto;
                border:1px solid var(--border);
                border-radius:var(--radius-lg);
              "
            >
              <table
                style="
                  width:100%;
                  border-collapse:collapse;
                  font-size:13px;
                "
              >
                <thead>
                  <tr style="border-bottom:2px solid var(--border)">
                    <th
                      style="
                        text-align:left;
                        padding:10px 12px;
                        font-size:11px;
                        font-weight:600;
                        color:var(--muted);
                        text-transform:uppercase;
                        letter-spacing:0.04em;
                      "
                    >
                      Time
                    </th>
                    <th
                      style="
                        text-align:left;
                        padding:10px 12px;
                        font-size:11px;
                        font-weight:600;
                        color:var(--muted);
                        text-transform:uppercase;
                        letter-spacing:0.04em;
                      "
                    >
                      Entity
                    </th>
                    <th
                      style="
                        text-align:left;
                        padding:10px 12px;
                        font-size:11px;
                        font-weight:600;
                        color:var(--muted);
                        text-transform:uppercase;
                        letter-spacing:0.04em;
                      "
                    >
                      Action
                    </th>
                    <th
                      style="
                        text-align:left;
                        padding:10px 12px;
                        font-size:11px;
                        font-weight:600;
                        color:var(--muted);
                        text-transform:uppercase;
                        letter-spacing:0.04em;
                      "
                    >
                      Transition
                    </th>
                    <th
                      style="
                        text-align:left;
                        padding:10px 12px;
                        font-size:11px;
                        font-weight:600;
                        color:var(--muted);
                        text-transform:uppercase;
                        letter-spacing:0.04em;
                      "
                    >
                      Actor
                    </th>
                    <th
                      style="
                        text-align:left;
                        padding:10px 12px;
                        font-size:11px;
                        font-weight:600;
                        color:var(--muted);
                        text-transform:uppercase;
                        letter-spacing:0.04em;
                      "
                    >
                      Detail
                    </th>
                  </tr>
                </thead>
                <tbody>
                  ${sorted.map((entry) => renderAuditRow(entry))}
                </tbody>
              </table>
            </div>
          `
          : nothing
      }
    </section>
  `;
}
