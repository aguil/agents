import type { WorkflowFeedConfig } from "@aguil/agents-workflow";
import { resolveConfigString } from "@aguil/agents-workflow";
import type { WorkFeedClient } from "./feed-client";
import { FakeWorkFeed } from "./feeds/fake";
import { GitHubIssuesFeed } from "./feeds/github-issues";
import { GitHubPrFeedbackFeed } from "./feeds/github-pr-feedback";
import { GitHubPrReviewFeed } from "./feeds/github-pr-review";
import { McpTrackerFeed, type McpTrackerFeedConfig } from "./feeds/mcp-tracker";

export interface CreateFeedsOptions {
  readonly workflowDir: string;
  readonly workspacePath: string;
  readonly feeds: readonly WorkflowFeedConfig[];
  readonly env?: NodeJS.ProcessEnv;
  readonly mcpInvoke?: (
    server: string,
    tool: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
}

const DEFAULT_ACTIVE = ["open", "todo", "in progress"];
const DEFAULT_TERMINAL = [
  "closed",
  "done",
  "cancelled",
  "canceled",
  "duplicate",
];

export function createWorkFeeds(
  options: CreateFeedsOptions,
): readonly WorkFeedClient[] {
  const clients: WorkFeedClient[] = [];
  for (const feed of options.feeds) {
    const client = createFeedClient(feed, options);
    if (client !== undefined) {
      clients.push(client);
    }
  }
  return clients;
}

function createFeedClient(
  feed: WorkflowFeedConfig,
  options: CreateFeedsOptions,
): WorkFeedClient | undefined {
  const raw = feed.raw;
  switch (feed.kind) {
    case "github_issues": {
      const repository =
        typeof raw.repository === "string"
          ? raw.repository
          : resolveConfigString(raw.project_slug, {
              workflowDir: options.workflowDir,
              env: options.env,
            });
      if (repository === undefined) {
        return undefined;
      }
      return new GitHubIssuesFeed({
        workspacePath: options.workspacePath,
        repository,
        activeStates: stringList(raw.active_states, DEFAULT_ACTIVE),
        terminalStates: stringList(raw.terminal_states, DEFAULT_TERMINAL),
      });
    }
    case "github_pr_review":
      return new GitHubPrReviewFeed({
        workspacePath: options.workspacePath,
        includeTeam: raw.include_team === true,
        maxOpen:
          typeof raw.max_open === "number"
            ? Math.floor(raw.max_open)
            : undefined,
      });
    case "github_pr_feedback":
      return new GitHubPrFeedbackFeed({
        workspacePath: options.workspacePath,
        repository:
          typeof raw.repository === "string" ? raw.repository : undefined,
      });
    case "mcp": {
      if (options.mcpInvoke === undefined) {
        return undefined;
      }
      const server = typeof raw.server === "string" ? raw.server : "";
      const listTool =
        typeof raw.list_tool === "string" ? raw.list_tool : "list_issues";
      if (server.length === 0) {
        return undefined;
      }
      const config: McpTrackerFeedConfig = {
        server,
        listTool,
        getTool: typeof raw.get_tool === "string" ? raw.get_tool : undefined,
        activeStates: stringList(raw.active_states, DEFAULT_ACTIVE),
        terminalStates: stringList(raw.terminal_states, DEFAULT_TERMINAL),
      };
      return new McpTrackerFeed(config, options.mcpInvoke);
    }
    case "fake":
      return new FakeWorkFeed([]);
    default:
      return undefined;
  }
}

function stringList(value: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }
  return [...fallback];
}
