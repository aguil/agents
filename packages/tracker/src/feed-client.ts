import type { WorkFeedTickContext } from "./feeds/pr-feedback-tick-cache";
import type { WorkItem } from "./work-item";

export type {
  PrFeedbackTickCache,
  WorkFeedTickContext,
} from "./feeds/pr-feedback-tick-cache";
export { createPrFeedbackTickCache } from "./feeds/pr-feedback-tick-cache";

export interface WorkFeedTerminalContext {
  /** When set, feeds may scope terminal discovery to existing work-item workspaces. */
  readonly workspaceRoot?: string;
  /** Cap expensive per-workspace probes during background startup cleanup. */
  readonly maxTerminalProbes?: number;
}

export interface WorkFeedClient {
  readonly feedKind: string;
  bindTickContext?(context: WorkFeedTickContext): void;
  fetchCandidates(): Promise<readonly WorkItem[]>;
  fetchStates(ids: readonly string[]): Promise<readonly WorkItem[]>;
  fetchTerminal(
    context?: WorkFeedTerminalContext,
  ): Promise<readonly WorkItem[]>;
}

export interface WorkFeedClientFactory {
  create(feed: {
    readonly kind: string;
    readonly raw: Readonly<Record<string, unknown>>;
  }): WorkFeedClient | undefined;
}
