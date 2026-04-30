export interface ContextRequest {
  readonly workspacePath: string;
  readonly diffPath?: string;
  readonly scratchpadPath: string;
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

export interface ContextBundle {
  readonly id: string;
  readonly artifacts: readonly ContextArtifact[];
}
