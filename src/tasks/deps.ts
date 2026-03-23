import type { TaskStore } from "./store.js";

/**
 * Validate that adding a dependency from taskId → dependsOnTaskId is legal.
 * Throws on: self-dep, missing task, cross-objective (unless opted in), cycle.
 */
export function validateDependency(
  taskId: string,
  dependsOnTaskId: string,
  store: TaskStore,
): void {
  // 1. No self-dependency
  if (taskId === dependsOnTaskId) {
    throw new Error(`Task ${taskId} cannot depend on itself`);
  }

  // 2. Dependency task must exist
  const depTask = store.getTask(dependsOnTaskId);
  if (!depTask) {
    throw new Error(`Dependency task ${dependsOnTaskId} not found`);
  }

  // 3. Task must exist
  const task = store.getTask(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  // 4. Same objective unless explicitly allowed via metadata.crossObjective
  if (depTask.objectiveId !== task.objectiveId) {
    if (!task.metadata?.crossObjective) {
      throw new Error(
        `Task ${taskId} (objective ${task.objectiveId}) cannot depend on ` +
          `task ${dependsOnTaskId} (objective ${depTask.objectiveId}) — ` +
          `cross-objective deps require metadata.crossObjective = true`,
      );
    }
  }

  // 5. Cycle detection
  if (wouldCreateCycle(taskId, dependsOnTaskId, store)) {
    throw new Error(`Adding dependency ${taskId} → ${dependsOnTaskId} would create a cycle`);
  }
}

/**
 * BFS from newDepId through its own dependencies.
 * If we reach taskId, adding this edge would create a cycle.
 */
export function wouldCreateCycle(taskId: string, newDepId: string, store: TaskStore): boolean {
  const visited = new Set<string>();
  const queue = [newDepId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const deps = store.getDependencies(current);
    queue.push(...deps);
  }
  return false;
}

/**
 * After a task completes, resolve its dependents.
 * Returns task IDs that were promoted to 'ready'.
 */
export function resolveDependents(taskId: string, store: TaskStore): string[] {
  const dependentIds = store.getDependents(taskId);
  const promoted: string[] = [];

  for (const depId of dependentIds) {
    const dep = store.getTask(depId);
    if (!dep) {
      continue;
    }

    // Only promote pending/scheduled tasks
    if (dep.status !== "pending" && dep.status !== "scheduled") {
      continue;
    }

    // Check if ALL deps are completed
    if (!store.allDepsCompleted(depId)) {
      continue;
    }

    // Check schedule
    if (dep.scheduledAt && dep.scheduledAt > Date.now()) {
      continue;
    }

    // Promote to ready
    try {
      store.updateTaskStatus(depId, "ready");
      promoted.push(depId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Illegal transition")) {
        // Expected race: task already promoted by another code path
      } else {
        throw err; // Propagate real errors (DB, FK, disk) to caller
      }
    }
  }

  return promoted;
}

/**
 * Add a dependency with full DAG validation.
 */
export function addValidatedDependency(
  taskId: string,
  dependsOnTaskId: string,
  store: TaskStore,
): void {
  validateDependency(taskId, dependsOnTaskId, store);
  store.addDependency(taskId, dependsOnTaskId);
}
