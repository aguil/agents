import type { WorkFeedClient } from "../feed-client";
import type { WorkItem } from "../work-item";

export interface McpTrackerFeedConfig {
  readonly server: string;
  readonly listTool: string;
  readonly getTool?: string;
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
}

/**
 * MCP-backed tracker feed. Invokes configured MCP tools to list and fetch issues.
 * Tool implementations are host-specific; this adapter expects JSON-shaped tool output.
 */
export class McpTrackerFeed implements WorkFeedClient {
  readonly feedKind = "mcp";

  constructor(
    private readonly config: McpTrackerFeedConfig,
    private readonly invokeTool: (
      server: string,
      tool: string,
      input: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {}

  async fetchCandidates(): Promise<readonly WorkItem[]> {
    const raw = await this.invokeTool(
      this.config.server,
      this.config.listTool,
      {
        active_states: this.config.activeStates,
      },
    );
    return normalizeMcpIssues(
      raw,
      this.config.activeStates,
      this.config.terminalStates,
    );
  }

  async fetchStates(ids: readonly string[]): Promise<readonly WorkItem[]> {
    if (this.config.getTool === undefined) {
      const all = await this.fetchCandidates();
      const wanted = new Set(ids);
      return all.filter((item) => wanted.has(item.id));
    }
    const items: WorkItem[] = [];
    for (const id of ids) {
      const raw = await this.invokeTool(
        this.config.server,
        this.config.getTool,
        {
          id,
        },
      );
      const normalized = normalizeMcpIssues(
        raw,
        this.config.activeStates,
        this.config.terminalStates,
      );
      if (normalized.length > 0) {
        items.push(normalized[0]);
      }
    }
    return items;
  }

  async fetchTerminal(): Promise<readonly WorkItem[]> {
    const raw = await this.invokeTool(
      this.config.server,
      this.config.listTool,
      {
        terminal_states: this.config.terminalStates,
      },
    );
    return normalizeMcpIssues(raw, [], this.config.terminalStates, true);
  }
}

function normalizeMcpIssues(
  raw: unknown,
  activeStates: readonly string[],
  terminalStates: readonly string[],
  terminalOnly = false,
): WorkItem[] {
  const rows = Array.isArray(raw)
    ? raw
    : typeof raw === "object" &&
        raw !== null &&
        Array.isArray((raw as { issues?: unknown }).issues)
      ? ((raw as { issues: unknown[] }).issues ?? [])
      : [];
  const active = new Set(activeStates.map((s) => s.toLowerCase()));
  const terminal = new Set(terminalStates.map((s) => s.toLowerCase()));
  const items: WorkItem[] = [];

  for (const row of rows) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? "");
    const identifier = String(r.identifier ?? id);
    const state = String(r.state ?? "unknown").toLowerCase();
    if (id.length === 0 || identifier.length === 0) {
      continue;
    }
    if (terminalOnly) {
      if (!terminal.has(state)) {
        continue;
      }
    } else if (!active.has(state) || terminal.has(state)) {
      continue;
    }
    items.push({
      id,
      identifier,
      title: String(r.title ?? identifier),
      description: typeof r.description === "string" ? r.description : null,
      state: String(r.state ?? "unknown"),
      kind: "mcp_tracker",
      priority: typeof r.priority === "number" ? Math.floor(r.priority) : null,
      url: typeof r.url === "string" ? r.url : null,
      labels: Array.isArray(r.labels)
        ? r.labels.map((l) => String(l).toLowerCase())
        : [],
      blockedBy: [],
      createdAt: typeof r.created_at === "string" ? r.created_at : null,
      updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
      branchName: typeof r.branch_name === "string" ? r.branch_name : null,
      metadata:
        typeof r.metadata === "object" && r.metadata !== null
          ? Object.fromEntries(
              Object.entries(r.metadata as Record<string, unknown>).map(
                ([k, v]) => [k, String(v)],
              ),
            )
          : {},
    });
  }
  return items;
}
