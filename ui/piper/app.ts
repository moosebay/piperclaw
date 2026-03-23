import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  GatewayBrowserClient,
  type GatewayHelloOk,
} from "../src/ui/gateway.ts";
import {
  type TasksState,
  DEFAULT_TASKS_STATE,
  loadObjectives,
  loadTasks,
  loadTaskDetail,
  loadAuditLog,
  approveTask,
  rejectTask,
  cancelObjective,
} from "../src/ui/controllers/tasks.ts";
import { renderObjectives } from "../src/ui/views/objectives.ts";
import { renderTasksKanban } from "../src/ui/views/tasks-kanban.ts";
import { renderAudit } from "../src/ui/views/audit.ts";

type PiperTab = "objectives" | "tasks" | "audit";

@customElement("piper-app")
export class PiperApp extends LitElement {
  @state() tab: PiperTab = "objectives";
  @state() connected = false;
  @state() connecting = false;
  @state() error: string | null = null;
  @state() hello: GatewayHelloOk | null = null;
  @state() tasksState: TasksState = { ...DEFAULT_TASKS_STATE };

  private client: GatewayBrowserClient | null = null;

  static styles = css`
    :host {
      --bg: #0a0a0a;
      --bg-surface: #141414;
      --bg-hover: #1a1a1a;
      --text: #e5e5e5;
      --text-secondary: #a3a3a3;
      --text-muted: #737373;
      --border: #262626;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --sidebar-width: 220px;

      display: flex;
      height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    .sidebar {
      width: var(--sidebar-width);
      min-width: var(--sidebar-width);
      background: var(--bg-surface);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      padding: 16px 0;
    }

    .sidebar-brand {
      padding: 0 20px 20px;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--text);
    }
    .sidebar-brand span { color: var(--accent); }

    .sidebar-section {
      padding: 0 12px;
      margin-bottom: 8px;
    }
    .sidebar-section-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      padding: 8px 8px 4px;
    }

    .sidebar-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 6px;
      cursor: pointer;
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.1s, color 0.1s;
    }
    .sidebar-item:hover { background: var(--bg-hover); color: var(--text); }
    .sidebar-item[data-active] { background: var(--accent); color: #fff; }
    .sidebar-item svg {
      width: 16px; height: 16px;
      stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }

    .sidebar-footer {
      margin-top: auto;
      padding: 12px 20px;
      border-top: 1px solid var(--border);
    }
    .connection-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #ef4444;
    }
    .status-dot[data-ok] { background: #22c55e; }

    .main {
      flex: 1;
      overflow: auto;
      padding: 24px 32px;
      min-width: 0;
    }

    .connect-screen {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      flex: 1;
    }
    .connect-box {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px 40px;
      text-align: center;
      max-width: 400px;
    }
    .connect-box h2 { margin-bottom: 8px; font-size: 20px; }
    .connect-box p { color: var(--text-secondary); margin-bottom: 20px; font-size: 13px; }
    .connect-box input {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 13px;
      margin-bottom: 12px;
      outline: none;
    }
    .connect-box input:focus { border-color: var(--accent); }
    .connect-box button {
      width: 100%;
      padding: 10px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .connect-box button:hover { background: var(--accent-hover); }
    .connect-box button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error-text { color: #ef4444; font-size: 12px; margin-top: 8px; }
  `;

  connectedCallback() {
    super.connectedCallback();
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    if (token) {
      this.connectWithToken(token);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.client?.stop();
  }

  private connectWithToken(token: string) {
    this.connecting = true;
    this.error = null;
    const wsUrl = `ws://${window.location.host}`;
    const client = new GatewayBrowserClient({
      url: wsUrl,
      token,
      mode: "ui" as any,
      clientName: "piper" as any,
      onHello: (hello) => {
        this.hello = hello;
        this.connected = true;
        this.connecting = false;
        void this.refresh();
      },
      onEvent: (evt) => {
        if (evt.event === "task.status" || evt.event === "objective.progress") {
          void this.refresh();
        }
      },
      onClose: ({ reason }) => {
        this.connected = false;
        if (reason && !this.error) {
          this.error = reason;
        }
      },
    });
    this.client = client;
    client.start();
  }

  private async refresh() {
    if (!this.client) return;
    const s = { ...this.tasksState };
    await Promise.all([
      loadObjectives(this.client, s),
      loadTasks(this.client, s),
      loadAuditLog(this.client, s),
    ]);
    this.tasksState = { ...s };
  }

  private async refreshObjectives() {
    if (!this.client) return;
    const s = { ...this.tasksState };
    await loadObjectives(this.client, s);
    this.tasksState = { ...s };
  }

  private setTab(tab: PiperTab) {
    this.tab = tab;
  }

  render() {
    if (!this.connected) {
      return this.renderConnect();
    }
    return html`
      ${this.renderSidebar()}
      <main class="main">
        ${this.tab === "objectives" ? this.renderObjectivesView() : nothing}
        ${this.tab === "tasks" ? this.renderTasksView() : nothing}
        ${this.tab === "audit" ? this.renderAuditView() : nothing}
      </main>
    `;
  }

  private renderConnect() {
    return html`
      <div class="connect-screen">
        <div class="connect-box">
          <h2>Piper</h2>
          <p>Enter your gateway auth token to connect.</p>
          <input
            id="token-input"
            type="password"
            placeholder="Gateway token"
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") {
                const input = this.shadowRoot?.getElementById("token-input") as HTMLInputElement;
                this.connectWithToken(input.value.trim());
              }
            }}
          />
          <button
            ?disabled=${this.connecting}
            @click=${() => {
              const input = this.shadowRoot?.getElementById("token-input") as HTMLInputElement;
              this.connectWithToken(input.value.trim());
            }}
          >
            ${this.connecting ? "Connecting..." : "Connect"}
          </button>
          ${this.error ? html`<p class="error-text">${this.error}</p>` : nothing}
        </div>
      </div>
    `;
  }

  private renderSidebar() {
    const tab = this.tab;
    return html`
      <nav class="sidebar">
        <div class="sidebar-brand"><span>P</span>iper</div>

        <div class="sidebar-section">
          <div class="sidebar-section-label">Dashboard</div>
          <a class="sidebar-item" ?data-active=${tab === "objectives"} @click=${() => this.setTab("objectives")}>
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Objectives
          </a>
          <a class="sidebar-item" ?data-active=${tab === "tasks"} @click=${() => this.setTab("tasks")}>
            <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/></svg>
            Tasks
          </a>
          <a class="sidebar-item" ?data-active=${tab === "audit"} @click=${() => this.setTab("audit")}>
            <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/></svg>
            Audit Log
          </a>
        </div>

        <div class="sidebar-footer">
          <div class="connection-status">
            <span class="status-dot" ?data-ok=${this.connected}></span>
            ${this.connected ? "Connected" : "Disconnected"}
          </div>
        </div>
      </nav>
    `;
  }

  private renderObjectivesView() {
    return renderObjectives({
      state: this.tasksState,
      connected: this.connected,
      onSelectObjective: (id) => {
        this.tasksState = { ...this.tasksState, selectedObjectiveId: id };
        if (id && this.client) {
          const s = { ...this.tasksState };
          void loadTasks(this.client, s, { objectiveId: id }).then(() => {
            this.tasksState = { ...s };
          });
        }
      },
      onCancelObjective: (id) => {
        if (this.client) {
          void cancelObjective(this.client, id).then(() => this.refresh());
        }
      },
      onRefresh: () => void this.refresh(),
    });
  }

  private renderTasksView() {
    return renderTasksKanban({
      state: this.tasksState,
      connected: this.connected,
      onSelectTask: (id) => {
        if (this.client) {
          const s = { ...this.tasksState };
          void loadTaskDetail(this.client, s, id).then(() => {
            this.tasksState = { ...s };
          });
        }
      },
      onApprove: (id) => {
        if (this.client) {
          void approveTask(this.client, id).then(() => this.refresh());
        }
      },
      onReject: (id) => {
        if (this.client) {
          void rejectTask(this.client, id).then(() => this.refresh());
        }
      },
      onRefresh: () => void this.refresh(),
      onStatusFilter: (status) => {
        this.tasksState = { ...this.tasksState, taskStatusFilter: status };
      },
      onSkillFilter: (skill) => {
        this.tasksState = { ...this.tasksState, taskSkillFilter: skill };
      },
      onObjectiveFilter: (id) => {
        this.tasksState = { ...this.tasksState, selectedObjectiveId: id };
        if (this.client) {
          const s = { ...this.tasksState, selectedObjectiveId: id };
          const filter = id ? { objectiveId: id } : undefined;
          void loadTasks(this.client, s, filter).then(() => {
            this.tasksState = { ...s };
          });
        }
      },
    });
  }

  private renderAuditView() {
    return renderAudit({
      state: this.tasksState,
      connected: this.connected,
      onFilterChange: (filter) => {
        this.tasksState = { ...this.tasksState, auditFilter: filter };
      },
      onRefresh: () => {
        if (this.client) {
          const s = { ...this.tasksState };
          void loadAuditLog(this.client, s).then(() => {
            this.tasksState = { ...s };
          });
        }
      },
    });
  }
}
