import { spawn } from "node:child_process";
import type { PrFeedbackPendingEntry } from "@aguil/agents-workflow";

export interface SelectionNotificationPayload {
  readonly selectionId: string;
  readonly workspacePath: string;
  readonly pending: readonly PrFeedbackPendingEntry[];
  readonly selectCommand: string;
  readonly approveUrl?: string;
}

export interface SelectionNotifyChannel {
  readonly kind: string;
  send(payload: SelectionNotificationPayload): Promise<void>;
}

export function buildSelectCommand(input: {
  readonly selectionId: string;
  readonly identifiers: readonly string[];
}): string {
  const parts = [
    "agents pr-feedback select",
    `--selection-id ${input.selectionId}`,
    ...input.identifiers.map((id) => `--approve ${id}`),
  ];
  return parts.join(" ");
}

export async function dispatchSelectionNotifications(input: {
  readonly channels: readonly SelectionNotifyChannel[];
  readonly payload: SelectionNotificationPayload;
}): Promise<void> {
  console.log(
    JSON.stringify({
      event: "pr_feedback_selection_required",
      selection_id: input.payload.selectionId,
      workspace_path: input.payload.workspacePath,
      pending_count: input.payload.pending.length,
      pending: input.payload.pending.map((p) => ({
        identifier: p.identifier,
        title: p.title,
        url: p.url,
        unresolved_threads: p.unresolvedThreads,
        reason: p.reason,
      })),
      select_command: input.payload.selectCommand,
    }),
  );

  await Promise.all(
    input.channels.map(async (channel) => {
      try {
        await channel.send(input.payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          JSON.stringify({
            event: "pr_feedback_selection_notify_failed",
            channel: channel.kind,
            error: message,
          }),
        );
      }
    }),
  );
}

export function createSelectionNotifyChannels(input: {
  readonly channelKinds: readonly string[];
  readonly webhookUrl?: string | null;
}): SelectionNotifyChannel[] {
  const channels: SelectionNotifyChannel[] = [];
  for (const kind of input.channelKinds) {
    if (kind === "jsonl") {
      channels.push({ kind: "jsonl", send: async () => {} });
    } else if (kind === "system") {
      channels.push({ kind: "system", send: sendSystemNotification });
    } else if (kind === "webhook" && input.webhookUrl) {
      const webhookUrl = input.webhookUrl;
      channels.push({
        kind: "webhook",
        send: (payload) => sendWebhook(webhookUrl, payload),
      });
    } else if (kind === "slack_webhook") {
      channels.push({ kind: "slack_webhook", send: sendSlackWebhook });
    } else if (kind === "email_smtp") {
      channels.push({ kind: "email_smtp", send: sendEmailStub });
    }
  }
  return channels;
}

async function sendSlackWebhook(
  payload: SelectionNotificationPayload,
): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL?.trim();
  if (url === undefined || url.length === 0) {
    return;
  }
  const text = [
    "*agentsd: PR feedback needs selection*",
    ...payload.pending.map(
      (p) => `• <${p.url}|${p.identifier}> — ${p.unresolvedThreads} thread(s)`,
    ),
    "",
    `\`${payload.selectCommand}\``,
  ].join("\n");
  await sendWebhook(url, { ...payload, selectCommand: text });
}

async function sendEmailStub(
  payload: SelectionNotificationPayload,
): Promise<void> {
  const to = process.env.AGENTSD_NOTIFY_EMAIL_TO?.trim();
  if (to === undefined || to.length === 0) {
    return;
  }
  console.log(
    JSON.stringify({
      event: "pr_feedback_selection_email",
      to,
      subject: "agentsd: PR feedback needs selection",
      body: payload.selectCommand,
      pending: payload.pending.map((p) => p.identifier),
    }),
  );
}

async function sendSystemNotification(
  payload: SelectionNotificationPayload,
): Promise<void> {
  const summary = payload.pending
    .map((p) => `${p.identifier} (${p.unresolvedThreads} threads)`)
    .join(", ");
  const title = "agentsd: PR feedback needs selection";
  const body =
    summary.length > 0
      ? `${summary}\n\n${payload.selectCommand}`
      : payload.selectCommand;

  if (process.platform === "darwin") {
    await runNotifyCommand([
      "terminal-notifier",
      "-title",
      title,
      "-message",
      body.slice(0, 200),
    ]);
    return;
  }
  if (process.platform === "linux") {
    await runNotifyCommand(["notify-send", title, body.slice(0, 200)]);
  }
}

async function runNotifyCommand(cmd: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd[0], cmd.slice(1), { stdio: "ignore" });
    proc.on("error", () => resolve());
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd[0]} exited ${code}`));
      }
    });
  });
}

async function sendWebhook(
  url: string,
  payload: SelectionNotificationPayload,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: "pr_feedback_selection_required",
      ...payload,
    }),
  });
  if (!response.ok) {
    throw new Error(`webhook HTTP ${response.status}`);
  }
}
