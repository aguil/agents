/** Options for one `agents code-review` invocation after config merge. */
export interface CliOptions {
  readonly workspace?: string;
  /** Root for resolving bare `owner/repo` workspaces (default ~/dev/repos). */
  readonly reposRoot?: string;
  readonly scratchpad?: string;
  readonly dryRun: boolean;
  readonly contextBundle?: string;
  readonly result?: string;
  readonly consensus?: string;
  readonly adapter?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly agent?: string;
  readonly opencode?: string;
  readonly claude?: string;
  /** CLI supplies a comma-separated string; merged JSON may supply a string or string array (preserves commas in tokens). */
  readonly claudeArgs?: string | readonly string[];
  readonly cursor?: string;
  readonly cursorArgs?: string | readonly string[];
  readonly cursorMode?: string;
  readonly log?: string;
  readonly pr?: string;
  readonly postPr?: string;
  readonly reviewSummary?: string;
  /**
   * Explicit `.agents/` directory for harness resolution; flag/env only.
   * Repo JSON must not choose harness definitions for another checkout.
   */
  readonly agentsDir?: string;
  readonly postOnly: boolean;
  readonly noConfirm: boolean;
  readonly replacePendingReview: boolean;
  readonly noDeterministic: boolean;
  readonly strict: boolean;
  readonly pendingReview: boolean;
  readonly pure: boolean;
  readonly printLogs: boolean;
}

export interface ParsedCodeReviewArgv {
  readonly options: CliOptions;
  /** Keys the user set on the CLI; these win over config and env. */
  readonly explicitKeys: ReadonlySet<keyof CliOptions>;
  readonly presetName?: string;
}
