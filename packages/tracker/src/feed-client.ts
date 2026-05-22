import type { WorkItem } from "./work-item";

export interface WorkFeedClient {
  readonly feedKind: string;
  fetchCandidates(): Promise<readonly WorkItem[]>;
  fetchStates(ids: readonly string[]): Promise<readonly WorkItem[]>;
  fetchTerminal(): Promise<readonly WorkItem[]>;
}

export interface WorkFeedClientFactory {
  create(feed: {
    readonly kind: string;
    readonly raw: Readonly<Record<string, unknown>>;
  }): WorkFeedClient | undefined;
}
