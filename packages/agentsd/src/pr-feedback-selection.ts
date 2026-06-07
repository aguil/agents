import {
  buildSelectCommand,
  createSelectionNotifyChannels,
  dispatchSelectionNotifications,
} from "@aguil/agents-publish";
import type { WorkFeedTickContext, WorkItem } from "@aguil/agents-tracker";
import type { WorkflowDefinition } from "@aguil/agents-workflow";
import {
  isPrApprovedForWork,
  isPrDeniedForWork,
  type PrFeedbackPendingEntry,
  pendingFingerprint,
  prIdentifierFromWorkItemMetadata,
  readSelectionDocument,
  upsertPendingFromWorkItems,
  writeSelectionDocument,
} from "@aguil/agents-workflow";
import { writeMonitorContext } from "./monitor-context";

export async function syncPrFeedbackSelection(input: {
  readonly definition: WorkflowDefinition;
  readonly hostWorkspacePath: string;
  readonly candidates: readonly WorkItem[];
  readonly tick?: WorkFeedTickContext;
}): Promise<readonly WorkItem[]> {
  const policy = input.definition.prFeedbackPolicy;
  const prFeedbackItems = input.candidates.filter(
    (item) =>
      item.kind === "github_pr_feedback" &&
      !isPrDeniedForWork(policy, item.metadata),
  );
  const otherItems = input.candidates.filter(
    (item) => item.kind !== "github_pr_feedback",
  );

  if (prFeedbackItems.length === 0) {
    return [...otherItems];
  }

  if (policy.profile === "discover_only") {
    return [...otherItems];
  }

  const pendingEntries: PrFeedbackPendingEntry[] = prFeedbackItems
    .map((item) => {
      const identifier = prIdentifierFromWorkItemMetadata(item.metadata);
      if (identifier === null) {
        return null;
      }
      return {
        identifier,
        title: item.title,
        url: item.url ?? "",
        unresolvedThreads: Number.parseInt(
          item.metadata.unresolved_thread_count ?? "0",
          10,
        ),
        reason: item.metadata.ingest_reason ?? "unresolved_threads",
      };
    })
    .filter((entry): entry is PrFeedbackPendingEntry => entry !== null);

  const cache = input.tick?.prFeedbackCache;
  const initialDoc = cache
    ? await cache.readSelection(input.hostWorkspacePath)
    : await readSelectionDocument(input.hostWorkspacePath);
  let doc = initialDoc;
  const pendingFingerprintBefore = pendingFingerprint(doc.pending);
  doc = upsertPendingFromWorkItems({ existing: doc, entries: pendingEntries });
  const pendingFingerprintAfter = pendingFingerprint(doc.pending);
  const pendingChanged = pendingFingerprintBefore !== pendingFingerprintAfter;

  const now = Date.now();
  const lastNotified = doc.notifiedAt ? Date.parse(doc.notifiedAt) : Number.NaN;
  const shouldNotify =
    doc.pending.length > 0 &&
    (doc.notifiedAt === null ||
      Number.isNaN(lastNotified) ||
      now - lastNotified >= policy.notifyCooldownMs ||
      pendingChanged);

  if (shouldNotify && policy.profile === "interactive") {
    const selectCommand = buildSelectCommand({
      selectionId: doc.selectionId,
      workspacePath: input.hostWorkspacePath,
      identifiers: doc.pending.map((p) => p.identifier),
    });
    const channels = createSelectionNotifyChannels({
      channelKinds: policy.notifyChannels.map((c) => c.kind),
      webhookUrl: policy.webhookUrl,
    });
    doc = {
      ...doc,
      notifiedAt: new Date(now).toISOString(),
      notifyFingerprint: pendingFingerprint(doc.pending),
    };
    void dispatchSelectionNotifications({
      channels,
      payload: {
        selectionId: doc.selectionId,
        workspacePath: input.hostWorkspacePath,
        pending: doc.pending,
        selectCommand,
      },
    });
  }

  if (JSON.stringify(doc) !== JSON.stringify(initialDoc)) {
    await writeSelectionDocument(input.hostWorkspacePath, doc);
    cache?.noteSelectionWrite(input.hostWorkspacePath, doc);
  }

  if (
    policy.monitorWorkspace !== null &&
    policy.monitorContextPath !== null &&
    (JSON.stringify(doc) !== JSON.stringify(initialDoc) || pendingChanged)
  ) {
    await writeMonitorContext({
      monitorWorkspace: policy.monitorWorkspace,
      contextPath: policy.monitorContextPath,
      hostWorkspacePath: input.hostWorkspacePath,
      workflowDir: input.definition.workflowDir,
      doc,
    });
  }

  const approved = new Set(doc.approved);
  const dispatchable = prFeedbackItems.filter((item) =>
    isPrApprovedForWork(policy, approved, item.metadata),
  );

  if (policy.profile === "unattended") {
    return [...otherItems, ...dispatchable];
  }

  if (policy.profile === "interactive") {
    return [...otherItems, ...dispatchable];
  }

  return [...otherItems];
}
