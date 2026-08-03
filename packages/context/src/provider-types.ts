export interface ContextRequest {
  readonly workspacePath: string;
  readonly scratchpadPath: string;
  /**
   * Harness-specific parameters. Generic providers read from here; the
   * legacy top-level fields below are the code-review specialization and
   * take precedence when both are set (migration window).
   */
  readonly params?: Readonly<Record<string, unknown>>;
  /** @deprecated Use `params.diffPath`. */
  readonly diffPath?: string;
  /** @deprecated Use `params.pullRequestNumber`. */
  readonly pullRequestNumber?: number;
}

export interface ContextArtifact {
  readonly id: string;
  readonly title: string;
  readonly path?: string;
  readonly content: string;
}

export interface ContextProvider {
  readonly name: string;
  collect(request: ContextRequest): Promise<readonly ContextArtifact[]>;
}

export type ContextProviderParams = Readonly<Record<string, unknown>>;
export type ContextProviderFactory = (
  params: ContextProviderParams,
) => ContextProvider;
