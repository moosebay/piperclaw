import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addValidatedDependency,
  resolveDependents,
  validateDependency,
  wouldCreateCycle,
} from "./deps.js";
import { TaskStore } from "./store.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-deps-test-"));
  return path.join(dir, "tasks.sqlite");
}

describe("deps", () => {
  let store: TaskStore;
  let objId: string;

  beforeEach(() => {
    store = new TaskStore(tmpDb());
    objId = store.createObjective({
      agentId: "main",
      title: "Test",
      description: "test",
    });
  });

  afterEach(() => {
    store.close();
  });

  // -----------------------------------------------------------------------
  // validateDependency
  // -----------------------------------------------------------------------

  describe("validateDependency", () => {
    it("rejects self-dependency", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      expect(() => validateDependency(t1, t1, store)).toThrow("cannot depend on itself");
    });

    it("rejects missing dependency task", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      expect(() => validateDependency(t1, "nonexistent", store)).toThrow("not found");
    });

    it("rejects missing source task", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      expect(() => validateDependency("nonexistent", t1, store)).toThrow("not found");
    });

    it("rejects cross-objective deps by default", () => {
      const obj2 = store.createObjective({
        agentId: "main",
        title: "Other",
        description: "other",
      });
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: obj2, title: "T2" });

      expect(() => validateDependency(t1, t2, store)).toThrow("cross-objective");
    });

    it("allows cross-objective deps when metadata.crossObjective is set", () => {
      const obj2 = store.createObjective({
        agentId: "main",
        title: "Other",
        description: "other",
      });
      const t1 = store.createTask({
        agentId: "main",
        objectiveId: objId,
        title: "T1",
        metadata: { crossObjective: true },
      });
      const t2 = store.createTask({ agentId: "main", objectiveId: obj2, title: "T2" });

      // Should not throw
      validateDependency(t1, t2, store);
    });

    it("accepts valid same-objective dependency", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });

      // Should not throw
      validateDependency(t2, t1, store);
    });
  });

  // -----------------------------------------------------------------------
  // wouldCreateCycle
  // -----------------------------------------------------------------------

  describe("wouldCreateCycle", () => {
    it("detects direct cycle", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      store.addDependency(t2, t1); // T2 depends on T1

      // Adding T1 depends on T2 would create T1→T2→T1 cycle
      expect(wouldCreateCycle(t1, t2, store)).toBe(true);
    });

    it("detects indirect cycle", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      const t3 = store.createTask({ agentId: "main", objectiveId: objId, title: "T3" });
      store.addDependency(t2, t1); // T2 depends on T1
      store.addDependency(t3, t2); // T3 depends on T2

      // Adding T1 depends on T3 would create T1→T3→T2→T1 cycle
      expect(wouldCreateCycle(t1, t3, store)).toBe(true);
    });

    it("allows valid DAG edges", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      const t3 = store.createTask({ agentId: "main", objectiveId: objId, title: "T3" });
      store.addDependency(t2, t1); // T2 depends on T1

      // T3 depends on T2 is valid (no cycle)
      expect(wouldCreateCycle(t3, t2, store)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // addValidatedDependency
  // -----------------------------------------------------------------------

  describe("addValidatedDependency", () => {
    it("adds dependency and persists it", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });

      addValidatedDependency(t2, t1, store);

      expect(store.getDependencies(t2)).toEqual([t1]);
    });

    it("rejects cycle", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      addValidatedDependency(t2, t1, store);

      expect(() => addValidatedDependency(t1, t2, store)).toThrow("cycle");
    });
  });

  // -----------------------------------------------------------------------
  // resolveDependents
  // -----------------------------------------------------------------------

  describe("resolveDependents", () => {
    it("promotes dependent task to ready when all deps complete", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      store.addDependency(t2, t1);

      // Complete T1
      store.updateTaskStatus(t1, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(t1, runId);
      store.completeTask(t1, runId, "completed");

      const promoted = resolveDependents(t1, store);
      expect(promoted).toEqual([t2]);
      expect(store.getTask(t2)!.status).toBe("ready");
    });

    it("does not promote when not all deps are complete", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      const t3 = store.createTask({ agentId: "main", objectiveId: objId, title: "T3" });
      store.addDependency(t3, t1);
      store.addDependency(t3, t2);

      // Complete only T1
      store.updateTaskStatus(t1, "ready");
      const runId = crypto.randomUUID();
      store.claimTask(t1, runId);
      store.completeTask(t1, runId, "completed");

      const promoted = resolveDependents(t1, store);
      expect(promoted).toEqual([]);
      expect(store.getTask(t3)!.status).toBe("pending");
    });

    it("cascades: completing A unblocks B, then completing B unblocks C", () => {
      const t1 = store.createTask({ agentId: "main", objectiveId: objId, title: "T1" });
      const t2 = store.createTask({ agentId: "main", objectiveId: objId, title: "T2" });
      const t3 = store.createTask({ agentId: "main", objectiveId: objId, title: "T3" });
      store.addDependency(t2, t1);
      store.addDependency(t3, t2);

      // Complete T1
      store.updateTaskStatus(t1, "ready");
      let runId = crypto.randomUUID();
      store.claimTask(t1, runId);
      store.completeTask(t1, runId, "completed");

      let promoted = resolveDependents(t1, store);
      expect(promoted).toEqual([t2]);

      // Complete T2
      runId = crypto.randomUUID();
      store.claimTask(t2, runId);
      store.completeTask(t2, runId, "completed");

      promoted = resolveDependents(t2, store);
      expect(promoted).toEqual([t3]);
      expect(store.getTask(t3)!.status).toBe("ready");
    });
  });
});
