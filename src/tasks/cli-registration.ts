/**
 * Task system CLI subcli registration entries.
 *
 * Returns entries in the same shape as `register.subclis.ts` expects, so the
 * host file only needs `...getTaskSubclis()` in its array.
 */
import type { SubCliDescriptor } from "../cli/program/subcli-descriptors.js";

type SubCliEntry = SubCliDescriptor & {
  register: (program: unknown) => Promise<void>;
};

/** Descriptor-only entries for subcli-descriptors.ts discovery. */
export const TASK_SUBCLI_DESCRIPTORS: readonly SubCliDescriptor[] = [
  { name: "objectives", description: "Manage task-system objectives", hasSubcommands: true },
  { name: "tasks", description: "Manage task-system tasks", hasSubcommands: true },
  { name: "reports", description: "Manage task-system reports", hasSubcommands: true },
];

/** Full entries with lazy register callbacks for register.subclis.ts. */
export function getTaskSubclis(): SubCliEntry[] {
  const loader = async (program: unknown) => {
    const mod = await import("../cli/tasks-cli.js");
    mod.registerTasksCli(program as Parameters<typeof mod.registerTasksCli>[0]);
  };

  return TASK_SUBCLI_DESCRIPTORS.map((desc) => ({ ...desc, register: loader }));
}
