import { runGhJson } from "@aguil/agents-github";
import type { WorkFeedClient, WorkFeedTerminalContext } from "../feed-client";
import type { WorkItem } from "../work-item";

interface GhIssueRow {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state: string;
  readonly labels?: readonly { readonly name?: string }[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly url?: string;
}

export interface GitHubIssuesFeedOptions {
  readonly workspacePath: string;
  readonly repository: string;
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
}

export class GitHubIssuesFeed implements WorkFeedClient {
  readonly feedKind = "github_issues";

  constructor(private readonly options: GitHubIssuesFeedOptions) {}

  async fetchCandidates(): Promise<readonly WorkItem[]> {
    const repo = this.options.repository;
    const rows = await runGhJson<readonly GhIssueRow[]>(
      [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--json",
        "number,title,body,state,labels,createdAt,updatedAt,url",
        "--limit",
        "100",
      ],
      this.options.workspacePath,
    );
    if (!Array.isArray(rows)) {
      return [];
    }
    const active = new Set(
      this.options.activeStates.map((s) => s.toLowerCase()),
    );
    const terminal = new Set(
      this.options.terminalStates.map((s) => s.toLowerCase()),
    );
    return rows
      .filter((row) => {
        const state = row.state.toLowerCase();
        return active.has(state) && !terminal.has(state);
      })
      .map((row) => toWorkItem(repo, row));
  }

  async fetchStates(ids: readonly string[]): Promise<readonly WorkItem[]> {
    const all = await this.fetchCandidates();
    const wanted = new Set(ids);
    return all.filter((item) => wanted.has(item.id));
  }

  async fetchTerminal(
    _context?: WorkFeedTerminalContext,
  ): Promise<readonly WorkItem[]> {
    const repo = this.options.repository;
    const rows = await runGhJson<readonly GhIssueRow[]>(
      [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "closed",
        "--json",
        "number,title,body,state,labels,createdAt,updatedAt,url",
        "--limit",
        "50",
      ],
      this.options.workspacePath,
    );
    if (!Array.isArray(rows)) {
      return [];
    }
    const terminal = new Set(
      this.options.terminalStates.map((s) => s.toLowerCase()),
    );
    return rows
      .filter((row) => terminal.has(row.state.toLowerCase()))
      .map((row) => toWorkItem(repo, row));
  }
}

function toWorkItem(repo: string, row: GhIssueRow): WorkItem {
  const number = row.number;
  const identifier = `${repo}#${number}`;
  return {
    id: `${repo}/issues/${number}`,
    identifier,
    title: row.title,
    description: row.body ?? null,
    state: row.state,
    kind: "github_issue",
    priority: null,
    url: row.url ?? null,
    labels: (row.labels ?? [])
      .map((l) => l.name?.toLowerCase() ?? "")
      .filter((n) => n.length > 0),
    blockedBy: [],
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    branchName: null,
    metadata: {
      repository: repo,
      issue_number: String(number),
    },
  };
}
