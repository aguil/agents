export type PrFeedbackProfile = "interactive" | "unattended" | "discover_only";

export interface PrFeedbackNotifyChannel {
  readonly kind: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface PrFeedbackPolicyConfig {
  readonly profile: PrFeedbackProfile;
  readonly allow: readonly string[];
  readonly notifyCooldownMs: number;
  readonly notifyChannels: readonly PrFeedbackNotifyChannel[];
  readonly webhookUrl: string | null;
  readonly monitorWorkspace: string | null;
  readonly monitorContextPath: string | null;
  readonly requireApprovalBeforeSubmit: boolean;
}

export const defaultPrFeedbackPolicy: PrFeedbackPolicyConfig = {
  profile: "interactive",
  allow: [],
  notifyCooldownMs: 300_000,
  notifyChannels: [
    { kind: "jsonl", raw: {} },
    { kind: "system", raw: {} },
  ],
  webhookUrl: null,
  monitorWorkspace: null,
  monitorContextPath: null,
  requireApprovalBeforeSubmit: true,
};

export function parsePrFeedbackPolicy(
  config: Readonly<Record<string, unknown>>,
): PrFeedbackPolicyConfig {
  const policy = asRecord(config.policy);
  const prFeedback = asRecord(policy.pr_feedback);
  const notify = asRecord(prFeedback.notify);

  const profile = parseProfile(prFeedback.profile);
  const allow = parseStringList(prFeedback.allow);

  const channels = parseNotifyChannels(notify.channels);
  const notifyChannels =
    channels.length > 0
      ? channels
      : [
          { kind: "jsonl", raw: {} },
          { kind: "system", raw: {} },
          ...(typeof notify.webhook_url === "string" &&
          notify.webhook_url.length > 0
            ? [{ kind: "webhook", raw: { url: notify.webhook_url } }]
            : []),
        ];

  const webhookFromChannel = channels.find((c) => c.kind === "webhook");
  const webhookUrl =
    typeof notify.webhook_url === "string" && notify.webhook_url.length > 0
      ? notify.webhook_url
      : typeof webhookFromChannel?.raw.url === "string"
        ? webhookFromChannel.raw.url
        : null;

  const requireApproval = asRecord(prFeedback.require_approval);

  const monitor = asRecord(notify.monitor);

  return {
    profile,
    allow,
    notifyCooldownMs: positiveInt(notify.cooldown_ms, 300_000),
    notifyChannels,
    webhookUrl,
    monitorWorkspace:
      typeof monitor.workspace === "string" && monitor.workspace.length > 0
        ? monitor.workspace
        : null,
    monitorContextPath:
      typeof monitor.context_path === "string" &&
      monitor.context_path.length > 0
        ? monitor.context_path
        : ".agentsd/monitor-context.json",
    requireApprovalBeforeSubmit: requireApproval.before_submit !== false,
  };
}

export function prIdentifierFromWorkItemMetadata(metadata: {
  readonly repository?: string;
  readonly pull_number?: string;
}): string | null {
  const repo = metadata.repository;
  const pr = metadata.pull_number;
  if (repo === undefined || pr === undefined) {
    return null;
  }
  return `${repo}#${pr}`;
}

export function isPrApprovedForWork(
  policy: PrFeedbackPolicyConfig,
  approved: ReadonlySet<string>,
  metadata: { readonly repository?: string; readonly pull_number?: string },
): boolean {
  if (policy.profile === "discover_only") {
    return false;
  }
  if (policy.profile === "unattended") {
    const id = prIdentifierFromWorkItemMetadata(metadata);
    if (id === null) {
      return false;
    }
    if (policy.allow.length === 0) {
      return false;
    }
    return policy.allow.includes(id);
  }
  const id = prIdentifierFromWorkItemMetadata(metadata);
  if (id === null) {
    return false;
  }
  return approved.has(id);
}

function parseProfile(value: unknown): PrFeedbackProfile {
  if (
    value === "interactive" ||
    value === "unattended" ||
    value === "discover_only"
  ) {
    return value;
  }
  return "interactive";
}

function parseStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

function parseNotifyChannels(
  value: unknown,
): readonly PrFeedbackNotifyChannel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: PrFeedbackNotifyChannel[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const raw = entry as Record<string, unknown>;
    const kind = typeof raw.kind === "string" ? raw.kind : "";
    if (kind.length === 0) {
      continue;
    }
    out.push({ kind, raw });
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}
