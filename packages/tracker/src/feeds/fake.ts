import type { WorkFeedClient, WorkFeedTerminalContext } from "../feed-client";
import type { WorkItem } from "../work-item";

export class FakeWorkFeed implements WorkFeedClient {
  readonly feedKind: string;

  constructor(
    private items: WorkItem[],
    private readonly terminal: WorkItem[] = [],
    feedKind = "fake",
  ) {
    this.feedKind = feedKind;
  }

  async fetchCandidates(): Promise<readonly WorkItem[]> {
    return this.items;
  }

  async fetchStates(ids: readonly string[]): Promise<readonly WorkItem[]> {
    const wanted = new Set(ids);
    return this.items.filter((i) => wanted.has(i.id));
  }

  async fetchTerminal(
    _context?: WorkFeedTerminalContext,
  ): Promise<readonly WorkItem[]> {
    return this.terminal;
  }

  setCandidates(items: readonly WorkItem[]): void {
    this.items = [...items];
  }
}
