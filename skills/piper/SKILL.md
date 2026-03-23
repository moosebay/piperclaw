---
name: piper
description: Create and manage Piper skills (managers and workers) for the task system. Use when the user asks to create a skill "for piper", "with piper structure", or mentions manager/worker roles for task automation. Triggers on phrases like "create a piper skill", "piper structure", "create a manager", "create a worker skill", "set up piper agents", "create a team", or "build a skill hierarchy".
user-invocable: true
---

# Piper Skill Creator

You help users create Piper skills — managers and workers for the task-driven workflow system.

## What is Piper?

Piper is a task system where:

- **Managers** create objectives and decompose them into tasks for workers
- **Workers** execute tasks and produce reports
- Skills are regular OpenClaw skills with `piper` metadata in their SKILL.md frontmatter
- The hierarchy is visible on the Piper dashboard at `/piper`

## How to create a Piper skill

Create a SKILL.md file at `~/.openclaw/workspace/skills/<skill-name>/SKILL.md` with this frontmatter format:

### Manager skill:

```yaml
---
name: <skill-name>
description: <what this manager does>
metadata:
  {
    "openclaw":
      {
        "emoji": "<emoji>",
        "piper":
          {
            "role": "manager",
            "type": "<Display Name>",
            "description": "<short description>",
            "workers": ["worker-skill-1", "worker-skill-2"],
          },
      },
  }
---
```

### Worker skill:

```yaml
---
name: <skill-name>
description: <what this worker does>
metadata:
  {
    "openclaw":
      {
        "emoji": "<emoji>",
        "piper":
          {
            "role": "worker",
            "type": "<Display Name>",
            "description": "<short description>",
            "capabilities": ["Action 1", "Action 2", "Action 3"],
          },
      },
  }
---
```

## Piper metadata fields

### Manager fields:

- `role`: Always `"manager"`
- `type`: Display name shown on the hierarchy chart (e.g. "Sales Manager")
- `description`: Short description of what this manager orchestrates
- `workers`: Array of worker skill names this manager dispatches work to

### Worker fields:

- `role`: Always `"worker"`
- `type`: Display name shown on the hierarchy chart (e.g. "LinkedIn Automation")
- `description`: Short description of what this worker does
- `capabilities`: Array of action labels shown as tags under the worker on the hierarchy chart (e.g. ["Send Connection", "Follow Up Message", "Profile Visit"])

## Rules

1. Every manager MUST have a `workers` array listing the skill names of its workers
2. Every worker MUST have `role: "worker"`, a descriptive `type`, and a `capabilities` array
3. `capabilities` should be 3-6 short action labels describing what the worker can do
4. Use relevant emojis for each skill
5. The skill body (after `---`) should contain detailed instructions for the agent when it's assigned this role
6. Manager skills should include instructions about:
   - How to decompose objectives into tasks
   - Which worker skills to assign to which task types
   - When to set `managerTrigger: "on_complete"` for review checkpoints
   - How to review worker reports and adjust plans
7. Worker skills should include instructions about:
   - How to execute the specific type of work
   - To always produce a report using the `report` tool
   - To use `waitForEvent` if human input is needed
   - To never create tasks (only managers do that)

## Example: Creating a sales team

When user says "Use piper structure and create a Sales Manager with LinkedIn Automation, Target Finder, and Email Sender workers":

1. Create manager: `sales-manager`
   - type: "Sales Manager"
   - workers: ["linkedin-automation-worker", "target-finder", "email-sender"]

2. Create worker: `linkedin-automation-worker`
   - type: "LinkedIn Automation"
   - capabilities: ["Send Connection", "Follow Up Message", "Profile Visit", "Accept Request"]

3. Create worker: `target-finder`
   - type: "Target Finder"
   - capabilities: ["Find Leads", "Verify Email", "Enrich Data", "Filter Prospects"]

4. Create worker: `email-sender`
   - type: "Email Sender"
   - capabilities: ["Cold Email", "Follow Up", "Reply Thread", "Batch Send"]

Each gets its own directory and SKILL.md at `~/.openclaw/workspace/skills/<name>/SKILL.md` with proper piper metadata and detailed skill instructions in the body.
