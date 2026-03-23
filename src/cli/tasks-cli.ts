import type { Command } from "commander";
import { addValidatedDependency } from "../tasks/deps.js";
import { getTaskStore } from "../tasks/service.runtime.js";
import { TaskStore } from "../tasks/store.js";
import type { ObjectiveFilter, ObjectiveStatus, TaskFilter, TaskStatus } from "../tasks/types.js";
import { registerTasksImportCli } from "./tasks-import-cli.js";

/**
 * Get a TaskStore handle. Prefers the running service singleton (shares WAL state),
 * falls back to opening the default DB path directly for CLI-only usage.
 */
function getStore(): { store: TaskStore; owned: boolean } {
  const running = getTaskStore();
  if (running) {
    return { store: running, owned: false };
  }
  return { store: new TaskStore(), owned: true };
}

function closeIfOwned(handle: { store: TaskStore; owned: boolean }): void {
  if (handle.owned) {
    handle.store.close();
  }
}

export function registerTasksCli(program: Command) {
  // ---------------------------------------------------------------------------
  // openclaw objectives
  // ---------------------------------------------------------------------------
  const objectives = program.command("objectives").description("Manage task-system objectives");

  objectives
    .command("list")
    .description("List objectives")
    .option("--status <status>", "Filter by status (active/paused/completed/cancelled)")
    .option("--agent <agentId>", "Filter by agent ID")
    .option("--json", "Output JSON", false)
    .action(async (opts: { status?: string; agent?: string; json?: boolean }) => {
      const handle = getStore();
      try {
        const store = handle.store;
        const filter: ObjectiveFilter = {};
        if (opts.status) {
          filter.status = opts.status as ObjectiveStatus;
        }
        if (opts.agent) {
          filter.agentId = opts.agent;
        }
        const results = store.listObjectives(filter);
        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          if (results.length === 0) {
            console.log("No objectives found.");
            return;
          }
          for (const obj of results) {
            const progress = store.getObjectiveProgress(obj.id);
            console.log(
              `${obj.id}  ${obj.status.padEnd(10)}  ${progress.completed}/${progress.total} done  ${obj.title}`,
            );
          }
        }
      } finally {
        closeIfOwned(handle);
      }
    });

  objectives
    .command("get")
    .description("Get objective details with progress")
    .argument("<id>", "Objective ID")
    .option("--json", "Output JSON", false)
    .action(async (id: string, opts: { json?: boolean }) => {
      const handle = getStore();
      try {
        const store = handle.store;
        const objective = store.getObjective(id);
        if (!objective) {
          console.error(`Objective ${id} not found`);
          process.exitCode = 1;
          return;
        }
        const progress = store.getObjectiveProgress(id);
        if (opts.json) {
          console.log(JSON.stringify({ objective, progress }, null, 2));
        } else {
          console.log(`ID:          ${objective.id}`);
          console.log(`Title:       ${objective.title}`);
          console.log(`Status:      ${objective.status}`);
          console.log(`Priority:    ${objective.priority}`);
          console.log(`Description: ${objective.description}`);
          console.log(`Proposed by: ${objective.proposedBy}`);
          console.log(
            `Progress:    ${progress.completed}/${progress.total} completed, ${progress.failed} failed, ${progress.running} running`,
          );
        }
      } finally {
        closeIfOwned(handle);
      }
    });

  objectives
    .command("create")
    .description("Create a new objective")
    .argument("<title>", "Objective title")
    .requiredOption("--description <text>", "What done looks like")
    .option("--agent <agentId>", "Agent ID", "main")
    .option("--priority <n>", "Priority (higher = more important)", "0")
    .action(
      async (title: string, opts: { description: string; agent: string; priority: string }) => {
        const handle = getStore();
        try {
          const store = handle.store;
          const id = store.createObjective({
            agentId: opts.agent,
            title,
            description: opts.description,
            priority: Number.parseInt(opts.priority, 10) || 0,
            proposedBy: "user",
          });
          console.log(`Created objective: ${id}`);
        } finally {
          closeIfOwned(handle);
        }
      },
    );

  // ---------------------------------------------------------------------------
  // openclaw tasks
  // ---------------------------------------------------------------------------
  const tasks = program.command("tasks").description("Manage task-system tasks");

  // Register import subcommands (openclaw tasks import json/sqlite)
  registerTasksImportCli(tasks);

  tasks
    .command("list")
    .description("List tasks")
    .option("--status <status>", "Filter by status")
    .option("--objective <id>", "Filter by objective ID")
    .option("--group <group>", "Filter by group")
    .option("--json", "Output JSON", false)
    .action(
      async (opts: { status?: string; objective?: string; group?: string; json?: boolean }) => {
        const handle = getStore();
        try {
          const store = handle.store;
          const filter: TaskFilter = {};
          if (opts.status) {
            filter.status = opts.status as TaskStatus;
          }
          if (opts.objective) {
            filter.objectiveId = opts.objective;
          }
          if (opts.group) {
            filter.group = opts.group;
          }
          const results = store.listTasks(filter);
          if (opts.json) {
            console.log(JSON.stringify(results, null, 2));
          } else {
            if (results.length === 0) {
              console.log("No tasks found.");
              return;
            }
            for (const t of results) {
              const skill = t.assignedSkill ? ` [${t.assignedSkill}]` : "";
              const group = t.group ? ` (${t.group})` : "";
              console.log(`${t.id}  ${t.status.padEnd(10)}  ${t.title}${skill}${group}`);
            }
          }
        } finally {
          closeIfOwned(handle);
        }
      },
    );

  tasks
    .command("get")
    .description("Get task details")
    .argument("<id>", "Task ID")
    .option("--json", "Output JSON", false)
    .action(async (id: string, opts: { json?: boolean }) => {
      const handle = getStore();
      try {
        const store = handle.store;
        const task = store.getTask(id);
        if (!task) {
          console.error(`Task ${id} not found`);
          process.exitCode = 1;
          return;
        }
        const report = store.getReportByTask(id);
        if (opts.json) {
          console.log(JSON.stringify({ task, report }, null, 2));
        } else {
          console.log(`ID:           ${task.id}`);
          console.log(`Title:        ${task.title}`);
          console.log(`Status:       ${task.status}`);
          console.log(`Objective:    ${task.objectiveId}`);
          console.log(`Priority:     ${task.priority}`);
          if (task.description) {
            console.log(`Description:  ${task.description}`);
          }
          if (task.assignedSkill) {
            console.log(`Skill:        ${task.assignedSkill}`);
          }
          if (task.group) {
            console.log(`Group:        ${task.group}`);
          }
          if (task.dependsOn?.length) {
            console.log(`Depends on:   ${task.dependsOn.join(", ")}`);
          }
          if (task.error) {
            console.log(`Error:        ${task.error}`);
          }
          if (report) {
            console.log(`Report:       ${report.title}`);
            console.log(`Summary:      ${report.summary}`);
          }
        }
      } finally {
        closeIfOwned(handle);
      }
    });

  tasks
    .command("create")
    .description("Create a new task")
    .argument("<title>", "Task title")
    .requiredOption("--objective <id>", "Objective ID")
    .option("--description <text>", "Task description")
    .option("--agent <agentId>", "Agent ID", "main")
    .option("--skill <skill>", "Worker skill to assign")
    .option("--group <group>", "Task group for fan-in")
    .option("--depends-on <ids...>", "Task IDs this depends on")
    .option("--priority <n>", "Priority", "0")
    .option("--max-retries <n>", "Max retries on failure", "0")
    .action(
      async (
        title: string,
        opts: {
          objective: string;
          description?: string;
          agent: string;
          skill?: string;
          group?: string;
          dependsOn?: string[];
          priority: string;
          maxRetries: string;
        },
      ) => {
        const handle = getStore();
        try {
          const store = handle.store;
          const taskId = store.createTask({
            agentId: opts.agent,
            objectiveId: opts.objective,
            title,
            description: opts.description,
            assignedSkill: opts.skill,
            group: opts.group,
            priority: Number.parseInt(opts.priority, 10) || 0,
            maxRetries: Number.parseInt(opts.maxRetries, 10) || 0,
          });

          if (opts.dependsOn) {
            for (const depId of opts.dependsOn) {
              addValidatedDependency(taskId, depId, store);
            }
          }

          console.log(`Created task: ${taskId}`);
        } finally {
          closeIfOwned(handle);
        }
      },
    );

  tasks
    .command("cancel")
    .description("Cancel a pending/scheduled/ready task")
    .argument("<id>", "Task ID")
    .action(async (id: string) => {
      const handle = getStore();
      try {
        const store = handle.store;
        const task = store.getTask(id);
        if (!task) {
          console.error(`Task ${id} not found`);
          process.exitCode = 1;
          return;
        }
        if (task.status !== "pending" && task.status !== "scheduled" && task.status !== "ready") {
          console.error(`Cannot cancel task in status ${task.status}`);
          process.exitCode = 1;
          return;
        }
        store.updateTaskStatus(id, "cancelled");
        console.log(`Cancelled task: ${id}`);
      } finally {
        closeIfOwned(handle);
      }
    });

  // ---------------------------------------------------------------------------
  // openclaw reports
  // ---------------------------------------------------------------------------
  const reports = program.command("reports").description("Manage task-system reports");

  reports
    .command("list")
    .description("List reports")
    .option("--objective <id>", "Filter by objective ID")
    .option("--task <id>", "Filter by task ID")
    .option("--json", "Output JSON", false)
    .action(async (opts: { objective?: string; task?: string; json?: boolean }) => {
      const handle = getStore();
      try {
        const store = handle.store;
        let results;
        if (opts.task) {
          const report = store.getReportByTask(opts.task);
          results = report ? [report] : [];
        } else if (opts.objective) {
          results = store.getReportsByObjective(opts.objective);
        } else {
          console.error("Provide --objective or --task filter");
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          if (results.length === 0) {
            console.log("No reports found.");
            return;
          }
          for (const r of results) {
            console.log(`${r.id}  ${r.title}  (task: ${r.taskId})`);
            console.log(`  ${r.summary}`);
          }
        }
      } finally {
        closeIfOwned(handle);
      }
    });

  reports
    .command("get")
    .description("Get full report content")
    .argument("<id>", "Report ID")
    .option("--json", "Output JSON", false)
    .action(async (id: string, opts: { json?: boolean }) => {
      const handle = getStore();
      try {
        const store = handle.store;
        const report = store.getReport(id);
        if (!report) {
          console.error(`Report ${id} not found`);
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(`Title:     ${report.title}`);
          console.log(`Task:      ${report.taskId}`);
          console.log(`Objective: ${report.objectiveId}`);
          console.log(`Format:    ${report.format}`);
          console.log(`Summary:   ${report.summary}`);
          console.log("");
          console.log(report.content);
        }
      } finally {
        closeIfOwned(handle);
      }
    });
}
