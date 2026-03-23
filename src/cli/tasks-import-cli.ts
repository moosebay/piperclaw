import fs from "node:fs";
import type { Command } from "commander";
import { requireNodeSqlite } from "../memory/sqlite.js";
import { getTaskStore } from "../tasks/service.runtime.js";
import { TaskStore } from "../tasks/store.js";
import type { RateLimit } from "../tasks/types.js";

// ---------------------------------------------------------------------------
// Rate-limit + delay string parsing
// ---------------------------------------------------------------------------

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;

function parseDurationMs(input: string): number {
  const match = input.trim().match(DURATION_RE);
  if (!match) {
    throw new Error(`Invalid duration: "${input}". Expected format: 60s, 2m, 1h, 7d`);
  }
  const value = Number.parseFloat(match[1]);
  switch (match[2]) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      throw new Error(`Unknown duration unit: ${match[2]}`);
  }
}

function parseRateLimit(input: string): RateLimit {
  // Format: "20/1h", "15/30m", "3/7d"
  const parts = input.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid rate limit: "${input}". Expected format: 20/1h, 15/30m`);
  }
  const maxPerWindow = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(maxPerWindow) || maxPerWindow <= 0) {
    throw new Error(`Invalid rate limit count: "${parts[0]}"`);
  }
  const windowMs = parseDurationMs(parts[1]);
  return { maxPerWindow, windowMs };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getStoreHandle(): { store: TaskStore; owned: boolean } {
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

type ImportRow = Record<string, unknown>;

function importRows(
  rows: ImportRow[],
  opts: {
    objective: string;
    objectiveDescription?: string;
    skill?: string;
    titleField: string;
    group?: string;
    maxRetries: number;
    rateLimit?: RateLimit;
    interTaskDelayMs?: number;
    agentId: string;
    dryRun: boolean;
  },
): void {
  if (rows.length === 0) {
    console.log("No matching rows to import.");
    return;
  }

  if (opts.dryRun) {
    console.log(`[dry-run] Would create objective: "${opts.objective}" with ${rows.length} tasks`);
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const row = rows[i];
      const rawTitle = row[opts.titleField];
      const title = typeof rawTitle === "string" ? rawTitle : `task-${i + 1}`;
      console.log(`  - ${title}`);
    }
    if (rows.length > 5) {
      console.log(`  ... and ${rows.length - 5} more`);
    }
    return;
  }

  const handle = getStoreHandle();
  try {
    const { store } = handle;
    store.transaction(() => {
      const objectiveId = store.createObjective({
        agentId: opts.agentId,
        title: opts.objective,
        description: opts.objectiveDescription ?? opts.objective,
        rateLimit: opts.rateLimit,
        interTaskDelayMs: opts.interTaskDelayMs,
      });

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rawTitle = row[opts.titleField];
        const title = typeof rawTitle === "string" ? rawTitle : `task-${i + 1}`;
        store.createTask({
          agentId: opts.agentId,
          objectiveId,
          title,
          description: JSON.stringify(row, null, 2),
          assignedSkill: opts.skill,
          group: opts.group,
          maxRetries: opts.maxRetries,
          metadata: row as Record<string, unknown>,
        });
      }

      console.log(`Created objective ${objectiveId} with ${rows.length} tasks`);
    });
  } finally {
    closeIfOwned(handle);
  }
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

function applyFilters(rows: ImportRow[], filters: string[]): ImportRow[] {
  if (filters.length === 0) {
    return rows;
  }
  return rows.filter((row) =>
    filters.every((f) => {
      const eqIdx = f.indexOf("=");
      if (eqIdx === -1) {
        return true;
      }
      const key = f.slice(0, eqIdx);
      const value = f.slice(eqIdx + 1);
      return String(row[key]) === value;
    }),
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTasksImportCli(program: Command) {
  const imp = program.command("import").description("Import tasks from external sources");

  // ---- JSON import ----
  imp
    .command("json")
    .description("Import tasks from a JSON file")
    .argument("<file>", "Path to JSON file (array or { tasks: [...] })")
    .requiredOption("--objective <title>", "Objective title")
    .option("--objective-description <text>", "Objective description")
    .option("--skill <name>", "Assigned skill for all tasks")
    .option("--title-field <field>", "Field to use as task title", "title")
    .option("--filter <key=value...>", "Filter rows (repeatable)", collectOption, [])
    .option("--group <name>", "Task group for fan-in")
    .option("--max-retries <n>", "Max retries per task", "0")
    .option("--rate-limit <spec>", "Rate limit (e.g., 20/1h)")
    .option("--inter-task-delay <duration>", "Delay between dispatches (e.g., 60s)")
    .option("--agent <agentId>", "Agent ID", "main")
    .option("--dry-run", "Preview without writing", false)
    .action(
      async (
        file: string,
        opts: {
          objective: string;
          objectiveDescription?: string;
          skill?: string;
          titleField: string;
          filter: string[];
          group?: string;
          maxRetries: string;
          rateLimit?: string;
          interTaskDelay?: string;
          agent: string;
          dryRun: boolean;
        },
      ) => {
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        let rows: ImportRow[] = Array.isArray(raw) ? raw : raw.tasks;
        if (!Array.isArray(rows)) {
          console.error("JSON must be an array or { tasks: [...] }");
          process.exitCode = 1;
          return;
        }
        rows = applyFilters(rows, opts.filter);
        importRows(rows, {
          objective: opts.objective,
          objectiveDescription: opts.objectiveDescription,
          skill: opts.skill,
          titleField: opts.titleField,
          group: opts.group,
          maxRetries: Number.parseInt(opts.maxRetries, 10) || 0,
          rateLimit: opts.rateLimit ? parseRateLimit(opts.rateLimit) : undefined,
          interTaskDelayMs: opts.interTaskDelay ? parseDurationMs(opts.interTaskDelay) : undefined,
          agentId: opts.agent,
          dryRun: opts.dryRun,
        });
      },
    );

  // ---- SQLite import ----
  imp
    .command("sqlite")
    .description("Import tasks from a SQLite database query")
    .argument("<db-path>", "Path to SQLite database")
    .requiredOption("--query <sql>", "SQL query to select rows")
    .requiredOption("--objective <title>", "Objective title")
    .option("--objective-description <text>", "Objective description")
    .option("--skill <name>", "Assigned skill for all tasks")
    .option("--title-field <field>", "Column to use as task title", "title")
    .option("--group <name>", "Task group for fan-in")
    .option("--max-retries <n>", "Max retries per task", "0")
    .option("--rate-limit <spec>", "Rate limit (e.g., 15/30m)")
    .option("--inter-task-delay <duration>", "Delay between dispatches (e.g., 2m)")
    .option("--agent <agentId>", "Agent ID", "main")
    .option("--dry-run", "Preview without writing", false)
    .action(
      async (
        dbPath: string,
        opts: {
          query: string;
          objective: string;
          objectiveDescription?: string;
          skill?: string;
          titleField: string;
          group?: string;
          maxRetries: string;
          rateLimit?: string;
          interTaskDelay?: string;
          agent: string;
          dryRun: boolean;
        },
      ) => {
        const { DatabaseSync } = requireNodeSqlite();
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const rows = db.prepare(opts.query).all() as ImportRow[];
          importRows(rows, {
            objective: opts.objective,
            objectiveDescription: opts.objectiveDescription,
            skill: opts.skill,
            titleField: opts.titleField,
            group: opts.group,
            maxRetries: Number.parseInt(opts.maxRetries, 10) || 0,
            rateLimit: opts.rateLimit ? parseRateLimit(opts.rateLimit) : undefined,
            interTaskDelayMs: opts.interTaskDelay
              ? parseDurationMs(opts.interTaskDelay)
              : undefined,
            agentId: opts.agent,
            dryRun: opts.dryRun,
          });
        } finally {
          db.close();
        }
      },
    );
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}
