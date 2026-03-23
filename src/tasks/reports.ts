import type { TaskStore } from "./store.js";
import type { ManagerWakeReason, TaskRecord } from "./types.js";

/**
 * Build context string for manager re-invocation based on trigger reason.
 */
export function buildManagerContext(
  reason: ManagerWakeReason,
  objectiveId: string,
  store: TaskStore,
): string {
  const objective = store.getObjective(objectiveId);
  if (!objective) {
    return `Objective ${objectiveId} not found.`;
  }

  const progress = store.getObjectiveProgress(objectiveId);
  const sections: string[] = [];

  sections.push(`Objective: ${objective.title}`);
  sections.push(`Description: ${objective.description}`);
  sections.push("");
  sections.push(
    `Progress: ${progress.completed}/${progress.total} completed, ` +
      `${progress.failed} failed, ${progress.running} running, ` +
      `${progress.pending + progress.scheduled + progress.ready} remaining`,
  );

  switch (reason.reason) {
    case "objective_completed": {
      sections.push("");
      sections.push("--- All tasks finished ---");
      sections.push("");
      appendTaskSummaries(objectiveId, store, sections);
      sections.push("");
      sections.push(
        "This objective is complete. Review the results. Report to the user. " +
          "Then evaluate: is there a logical next objective? If yes, propose it " +
          "with a clear description of what done looks like. If you're unsure, " +
          "ask the user what to focus on next.",
      );
      break;
    }

    case "task_failed": {
      const failedTask = store.getTask(reason.taskId);
      sections.push("");
      sections.push("--- Task failure (retries exhausted) ---");
      if (failedTask) {
        sections.push(`Task: ${failedTask.title} (${failedTask.id})`);
        sections.push(`Error: ${failedTask.error ?? "unknown"}`);
        sections.push(`Retries: ${failedTask.retryCount}/${failedTask.maxRetries}`);
      }
      sections.push("");
      sections.push(
        "This task failed after all retries. Decide: create a replacement task " +
          "with a different approach, skip this branch and adjust the plan, or " +
          "escalate to the user.",
      );
      break;
    }

    case "group_completed": {
      const groupTasks = store.getTasksByGroup(reason.group);
      sections.push("");
      sections.push(`--- Group "${reason.group}" complete ---`);
      sections.push("");
      for (const task of groupTasks) {
        const report = store.getReportByTask(task.id);
        const reportSummary = report ? ` — Report: ${report.summary}` : "";
        sections.push(`- ${task.title}: ${task.status}${reportSummary}`);
      }
      sections.push("");
      sections.push(
        "All tasks in this group are complete. Review the results and adjust " +
          "downstream tasks if needed before they dispatch.",
      );
      break;
    }

    case "task_review": {
      const reviewTask = store.getTask(reason.taskId);
      sections.push("");
      sections.push("--- Task flagged for review ---");
      if (reviewTask) {
        sections.push(`Task: ${reviewTask.title} (${reviewTask.id})`);
        sections.push(`Status: ${reviewTask.status}`);
        const report = store.getReportByTask(reviewTask.id);
        if (report) {
          sections.push(`Report: ${report.title}`);
          sections.push(`Summary: ${report.summary}`);
        }
      }
      sections.push("");
      sections.push("Review this task's output and decide next steps.");
      break;
    }

    case "user_interrupt": {
      sections.push("");
      sections.push("--- User interrupt ---");
      sections.push("");
      appendRunningTasksSummary(objectiveId, store, sections);
      sections.push("");
      sections.push(
        "The user has sent a message. Review current state and respond. " +
          "You can reprioritize, cancel tasks, create new tasks, or respond.",
      );
      break;
    }
  }

  return sections.join("\n");
}

/**
 * Build worker prompt context with dependency report summaries.
 */
export function buildWorkerPrompt(task: TaskRecord, depReportSummaries: string[]): string {
  const sections: string[] = [];

  sections.push(`# Task: ${task.title}`);
  sections.push(`Task ID: ${task.id}`);
  if (task.description) {
    sections.push("");
    sections.push(task.description);
  }

  // Serialize all metadata as key-value pairs so the skill can use them
  if (task.metadata && Object.keys(task.metadata).length > 0) {
    sections.push("");
    sections.push("## Task metadata");
    for (const [key, value] of Object.entries(task.metadata)) {
      const display = typeof value === "string" ? value : JSON.stringify(value);
      sections.push(`${key}: ${display}`);
    }
  }

  if (depReportSummaries.length > 0) {
    sections.push("");
    sections.push("## Context from prior tasks:");
    for (const summary of depReportSummaries) {
      sections.push(`- ${summary}`);
    }
  }

  sections.push("");
  sections.push("## Instructions");
  sections.push("");
  if (task.assignedSkill) {
    sections.push(`You are assigned skill: ${task.assignedSkill}`);
    sections.push(
      "Execute this task using the skill's full procedures. " +
        "The metadata above provides parameters and context for this run.",
    );
    sections.push("");
  }
  sections.push(
    "When done, produce a report summarizing what you did using the report tool " +
      "(pass the taskId above). Do not create new tasks.",
  );

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendTaskSummaries(objectiveId: string, store: TaskStore, sections: string[]): void {
  const tasks = store.getTasksByObjective(objectiveId);
  const completed = tasks.filter((t) => t.status === "completed");
  const failed = tasks.filter((t) => t.status === "failed");
  const cancelled = tasks.filter((t) => t.status === "cancelled");

  if (completed.length > 0) {
    sections.push("Completed tasks:");
    for (const t of completed) {
      const report = store.getReportByTask(t.id);
      const reportSummary = report ? ` — Report: ${report.summary}` : "";
      sections.push(`- ${t.title}: completed${reportSummary}`);
    }
  }

  if (failed.length > 0) {
    sections.push("");
    sections.push("Failed tasks:");
    for (const t of failed) {
      sections.push(`- ${t.title}: failed — ${t.error ?? "unknown error"}`);
    }
  }

  if (cancelled.length > 0) {
    sections.push("");
    sections.push("Cancelled tasks:");
    for (const t of cancelled) {
      sections.push(`- ${t.title}: cancelled`);
    }
  }
}

function appendRunningTasksSummary(
  objectiveId: string,
  store: TaskStore,
  sections: string[],
): void {
  const tasks = store.getTasksByObjective(objectiveId);
  const running = tasks.filter((t) => t.status === "running");
  const pending = tasks.filter(
    (t) => t.status === "pending" || t.status === "ready" || t.status === "scheduled",
  );

  if (running.length > 0) {
    sections.push(`Running tasks (${running.length}):`);
    for (const t of running) {
      sections.push(`- ${t.title}`);
    }
  }

  if (pending.length > 0) {
    sections.push(`Pending tasks (${pending.length}):`);
    for (const t of pending) {
      sections.push(`- ${t.title} (${t.status})`);
    }
  }
}
