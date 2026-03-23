import { taskLog as log } from "./log.js";

// ---------------------------------------------------------------------------
// Notification config — resolved from objective metadata
// ---------------------------------------------------------------------------

export type TaskNotificationConfig = {
  /** Channel identifier (e.g. "telegram", "whatsapp", "discord"). */
  channel: string;
  /** Recipient identifier (chat ID, phone number, etc.). */
  to: string;
  /** Optional account ID for multi-account channels. */
  accountId?: string;
};

/**
 * Resolve notification config from objective metadata.
 *
 * Convention: metadata fields `notifyChannel`, `notifyTo`, and optionally
 * `notifyAccountId` control where task notifications are delivered.
 */
export function resolveNotificationConfig(
  metadata?: Record<string, unknown>,
): TaskNotificationConfig | null {
  const channel = metadata?.notifyChannel;
  const to = metadata?.notifyTo;
  if (typeof channel !== "string" || typeof to !== "string") {
    return null;
  }
  if (!channel.trim() || !to.trim()) {
    return null;
  }
  return {
    channel: channel.trim(),
    to: to.trim(),
    accountId:
      typeof metadata?.notifyAccountId === "string" ? metadata.notifyAccountId.trim() : undefined,
  };
}

// ---------------------------------------------------------------------------
// Notification delivery
// ---------------------------------------------------------------------------

/**
 * Send a task notification to a messaging channel.
 *
 * Uses `deliverOutboundPayloads` from the outbound delivery system.
 * Fire-and-forget: errors are logged but never thrown.
 */
export async function sendTaskNotification(
  config: TaskNotificationConfig,
  text: string,
): Promise<void> {
  try {
    // Dynamic imports to avoid circular deps and keep this module lightweight.
    // The outbound delivery system requires an OpenClawConfig and a valid
    // channel string. We load config at call time so it reflects the latest
    // gateway state.
    const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
    const { loadConfig } = await import("../config/io.js");
    const cfg = loadConfig();

    await deliverOutboundPayloads({
      cfg,
      channel: config.channel as Parameters<typeof deliverOutboundPayloads>[0]["channel"],
      to: config.to,
      accountId: config.accountId,
      payloads: [{ text }],
      bestEffort: true,
      skipQueue: true,
    });
  } catch (err) {
    log.error(`Failed to send task notification: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Notification text formatters
// ---------------------------------------------------------------------------

export function formatObjectiveCompleted(title: string, completed: number, total: number): string {
  return `Objective complete: "${title}" -- ${completed}/${total} tasks done`;
}

export function formatTaskFailed(title: string, error?: string): string {
  const suffix = error ? ` -- ${error}` : "";
  return `Task failed (retries exhausted): "${title}"${suffix}`;
}

export function formatApprovalRequest(taskTitle: string, taskId: string): string {
  return (
    `Task waiting for approval: "${taskTitle}" (${taskId})\n` +
    `Approve with: openclaw tasks approve ${taskId}`
  );
}
