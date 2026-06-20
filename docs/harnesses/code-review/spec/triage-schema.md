# Triage Schema

Schemas for the output of `agents triage`. Defined in
`packages/triage/src/types.ts` and published as `@aguil/agents-triage`.

## Schema IDs

| Schema          | ID                                                    |
| --------------- | ----------------------------------------------------- |
| Triage envelope | `https://aguil.dev/schemas/agents/triage-envelope/v1` |

## `TriageEnvelopeV1`

Top-level document written to `triage-queue.json` (and optionally
`triage-queue.toon`) under `.agents-triage/<outputSlug>/`.

```typescript
interface TriageEnvelopeV1 {
  schemaId: "https://aguil.dev/schemas/agents/triage-envelope/v1";
  schemaVersion: 1;
  generatedAt: string; // ISO 8601
  workspacePath: string; // Absolute workspace path
  outputSlug: string; // Derived from producer + artifact fingerprint
  upstream?: {
    producer: string; // "code-review" | "pr-feedback"
    resultPath?: string; // Absolute path to ingress artifact
    upstreamRunId?: string; // Run ID from upstream harness result
    metadataSubset?: Record<string, string>;
  };
  items: TriageItemV1[];
}
```

### Fields

| Field                     | Type      | Description                                                                           |
| ------------------------- | --------- | ------------------------------------------------------------------------------------- |
| `schemaId`                | `string`  | Fixed schema URI for envelope version                                                 |
| `schemaVersion`           | `1`       | Literal `1`; increment on breaking schema change                                      |
| `generatedAt`             | `string`  | ISO 8601 timestamp when the envelope was written                                      |
| `workspacePath`           | `string`  | Absolute path to the workspace root used during triage                                |
| `outputSlug`              | `string`  | Stable directory name under `.agents-triage/`; encodes producer + ingress fingerprint |
| `upstream.producer`       | `string`  | Which producer fed this envelope (`code-review` or `pr-feedback`)                     |
| `upstream.resultPath`     | `string?` | Absolute path to the ingress artifact                                                 |
| `upstream.upstreamRunId`  | `string?` | Run ID from the upstream harness result                                               |
| `upstream.metadataSubset` | `object?` | Key subset of upstream `result.json → metadata`                                       |

## `TriageItemV1`

Individual finding within an envelope.

```typescript
interface TriageItemV1 {
  id: string;
  kind: string;
  severity: FindingSeverity; // "critical" | "high" | "medium" | "low" | "info"
  title: string;
  detail: string;
  anchors: TriageItemAnchor[];
  source: Record<string, string>;
}

interface TriageItemAnchor {
  path: string;
  line?: number;
}
```

### Fields

| Field      | Type                     | Description                                                          |
| ---------- | ------------------------ | -------------------------------------------------------------------- |
| `id`       | `string`                 | Stable unique identifier for the item within this envelope           |
| `kind`     | `string`                 | Item category (producer-defined, e.g. `finding`, `pr_review_thread`) |
| `severity` | `FindingSeverity`        | `critical`, `high`, `medium`, `low`, or `info`                       |
| `title`    | `string`                 | Short human-readable summary                                         |
| `detail`   | `string`                 | Full description of the issue                                        |
| `anchors`  | `TriageItemAnchor[]`     | File/line locations (may be empty)                                   |
| `source`   | `Record<string, string>` | Upstream provenance (e.g. role, thread ID, author)                   |

## Output files

| File                | Description                                                    |
| ------------------- | -------------------------------------------------------------- |
| `triage-queue.json` | JSON-serialized `TriageEnvelopeV1` (always written)            |
| `triage-queue.toon` | Toon-encoded envelope (optional; requires `@toon-format/toon`) |

Both files are written to `.agents-triage/<outputSlug>/` by default.

## Related

- [agents triage guide](../../../guide/triage.md) — usage and options
- [review-contract.md](review-contract.md) — upstream code-review schema
- [spec/events-catalog.md](events-catalog.md) — JSONL event catalog
