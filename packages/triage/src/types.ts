import type { FindingSeverity } from "@aguil/agents-core";

export const TRIAGE_ENVELOPE_SCHEMA_ID =
  "https://aguil.dev/schemas/agents/triage-envelope/v1" as const;

export interface TriageItemAnchor {
  readonly path: string;
  readonly line?: number;
}

export interface TriageItemV1 {
  readonly id: string;
  readonly kind: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
  readonly anchors: readonly TriageItemAnchor[];
  readonly source: Readonly<Record<string, string>>;
}

export interface TriageEnvelopeV1 {
  readonly schemaId: typeof TRIAGE_ENVELOPE_SCHEMA_ID;
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly workspacePath: string;
  readonly outputSlug: string;
  readonly upstream?: Readonly<{
    producer: string;
    resultPath?: string;
    upstreamRunId?: string;
    metadataSubset?: Readonly<Record<string, string>>;
  }>;
  readonly items: readonly TriageItemV1[];
}
