import type { WorkFeedClient } from "../feed-client";
import type { WorkItem } from "../work-item";

export class FakeWorkFeed implements WorkFeedClient {
  readonly feedKind = "fake";

  constructor(
    private items: WorkItem[],
    private readonly terminal: WorkItem[] = [],
  ) {}

  async fetchCandidates(): Promise<readonly WorkItem[]> {
    return this.items;
  }

  async fetchStates(ids: readonly string[]): Promise<readonly WorkItem[]> {
    const wanted = new Set(ids);
    return this.items.filter((i) => wanted.has(i.id));
  }

  async fetchTerminal(): Promise<readonly WorkItem[]> {
    return this.terminal;
  }

  setCandidates(items: readonly WorkItem[]): void {
    this.items = [...items];
  }
}
