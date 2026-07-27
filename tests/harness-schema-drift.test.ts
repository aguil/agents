import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findAllSchemaViolations,
  HARNESS_SCHEMA,
  type JsonSchema,
  LOADER_ACCEPTED_KEYS,
  type LoaderKeyLevel,
  loadHarness,
  MANIFEST_SCHEMA,
  POLICY_SCHEMA,
} from "@aguil/agents-harness-config";

/**
 * Two descriptions of the `.agents/` document formats exist — the published
 * schemas and the loader's own parsing — and they can disagree in two ways,
 * only one of which is loud.
 *
 * A key the loader knows and the schema does not is rejected at load, so it
 * surfaces at the first document that uses it. A key the schema knows and the
 * loader does not is accepted and silently ignored, which is the bug the
 * schemas were introduced to remove. The tests below cover the quiet
 * direction, plus the constraint-level equivalent: a document the loader
 * refuses that the published schema would accept.
 */

function at(schema: JsonSchema, path: readonly string[]): JsonSchema {
  let node: unknown = schema;
  for (const segment of path) {
    node = (node as Record<string, unknown> | undefined)?.[segment];
  }
  if (node === undefined) {
    throw new Error(`no schema node at ${path.join(".")}`);
  }
  return node as JsonSchema;
}

function propertyNamesOf(node: JsonSchema): readonly string[] {
  return Object.keys(
    (node.properties as Record<string, unknown> | undefined) ?? {},
  ).sort();
}

const KEY_SURFACE_PAIRS: readonly {
  readonly level: LoaderKeyLevel;
  readonly schema: JsonSchema;
  readonly path: readonly string[];
  /**
   * Keys the schema names but the loader does not accept. Only one case
   * exists: `prompt` and `http` are declared with `not: {}` so that using a
   * non-command handler is reported as an unsupported handler type instead of
   * as a misspelling. Note that `applies_to` on a lifecycle handler is *not*
   * one of these — the loader accepts the key and rejects it semantically,
   * with a message explaining that event-class scoping is tool-call only.
   */
  readonly schemaOnly?: readonly string[];
}[] = [
  { level: "harnessRoot", schema: HARNESS_SCHEMA, path: [] },
  {
    level: "harnessIdentity",
    schema: HARNESS_SCHEMA,
    path: ["properties", "harness"],
  },
  { level: "role", schema: HARNESS_SCHEMA, path: ["definitions", "role"] },
  {
    level: "execution",
    schema: HARNESS_SCHEMA,
    path: ["definitions", "execution"],
  },
  {
    level: "hookHandler",
    schema: HARNESS_SCHEMA,
    path: ["definitions", "toolCallHandlers", "items"],
    schemaOnly: ["prompt", "http"],
  },
  {
    level: "hookHandler",
    schema: HARNESS_SCHEMA,
    path: ["definitions", "lifecycleHandlers", "items"],
    schemaOnly: ["prompt", "http"],
  },
  {
    level: "context",
    schema: HARNESS_SCHEMA,
    path: ["properties", "context"],
  },
  { level: "output", schema: HARNESS_SCHEMA, path: ["properties", "output"] },
  {
    level: "outputSchema",
    schema: HARNESS_SCHEMA,
    path: ["definitions", "recordOutputSchema"],
  },
  {
    level: "findingStrategies",
    schema: HARNESS_SCHEMA,
    path: ["properties", "filtering"],
  },
  {
    level: "findingStrategies",
    schema: HARNESS_SCHEMA,
    path: ["properties", "deduplication"],
  },
  {
    level: "reporting",
    schema: HARNESS_SCHEMA,
    path: ["properties", "reporting"],
  },
  { level: "manifestRoot", schema: MANIFEST_SCHEMA, path: [] },
  {
    level: "manifestEnabled",
    schema: MANIFEST_SCHEMA,
    path: ["properties", "enabled"],
  },
  { level: "policyRoot", schema: POLICY_SCHEMA, path: [] },
  {
    level: "policyCapabilities",
    schema: POLICY_SCHEMA,
    path: ["properties", "capabilities"],
  },
  {
    level: "policyCapabilityRules",
    schema: POLICY_SCHEMA,
    path: ["definitions", "capabilityRules"],
  },
  {
    level: "policyLimits",
    schema: POLICY_SCHEMA,
    path: ["properties", "limits"],
  },
  {
    level: "policyConfirmations",
    schema: POLICY_SCHEMA,
    path: ["properties", "confirmations"],
  },
];

test("every schema level describes exactly the keys the loader reads", () => {
  for (const pair of KEY_SURFACE_PAIRS) {
    const node = at(pair.schema, pair.path);
    const schemaOnly = new Set(pair.schemaOnly ?? []);
    const fromSchema = propertyNamesOf(node).filter(
      (key) => !schemaOnly.has(key),
    );
    const fromLoader = [...LOADER_ACCEPTED_KEYS[pair.level]].sort();
    const where = `${pair.level} @ ${pair.path.join(".") || "<root>"}`;
    expect([where, fromSchema]).toEqual([where, fromLoader]);
  }
});

test("every level of every schema is closed to unknown keys", () => {
  // Walking rather than listing: a level added later is covered without this
  // test being told about it, which is the drift most likely to slip through.
  const open: string[] = [];
  const walk = (node: unknown, path: string, schema: JsonSchema): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return;
    }
    const record = node as Record<string, unknown>;
    // `type: "object"` is what makes a node a level. An `if` clause also
    // carries `properties`, but it selects between branches rather than
    // describing a document position, and has nothing to close.
    if (record.type === "object") {
      const additional = record.additionalProperties;
      // `false` closes the level outright; a subschema means the level is a
      // map whose values are constrained, which is closed in the sense that
      // matters. Anything else lets an arbitrary key through.
      const closed =
        additional === false ||
        (typeof additional === "object" && additional !== null);
      if (!closed) {
        open.push(path);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      walk(value, path === "" ? key : `${path}.${key}`, schema);
    }
  };
  for (const [name, schema] of [
    ["harness", HARNESS_SCHEMA],
    ["manifest", MANIFEST_SCHEMA],
    ["policy", POLICY_SCHEMA],
  ] as const) {
    walk(schema, name, schema);
  }
  // `contextProvider` is open by design: keys other than `use` are provider
  // parameters, validated by the provider registry rather than here.
  expect(open).toEqual(["harness.definitions.contextProvider"]);
});

/**
 * Documents the loader refuses. ADR 0018 states that the loader enforces a
 * subset of the schema, so a strict third-party validator running the
 * published file must refuse each of these too. Both of the first two entries
 * were real disagreements before this test existed.
 */
const REJECTED_HARNESS_DOCUMENTS: readonly {
  readonly why: string;
  readonly lines: readonly string[];
  readonly roles?: string;
}[] = [
  {
    why: "builtin:finding is bound to the finding kind",
    lines: ["output:", "  schemas:", "    evidence: builtin:finding"],
  },
  {
    why: "outcome field names are trimmed before the empty check",
    lines: ["output:", "  schemas:", '    evidence: { required: [" "] }'],
  },
  {
    why: "unknown key at the document root",
    lines: ["polciy: guard"],
  },
  {
    why: "unknown role key",
    lines: [],
    roles: "roles: { a: { description: A, timeout_msec: 10 } }",
  },
  {
    why: "role identifier that would escape the scratchpad directory",
    lines: [],
    roles: "roles: { ../escape: { description: A } }",
  },
  {
    why: "hook handler types other than command are out of spec",
    lines: ["hooks:", "  role_stop:", "    - prompt: say something"],
  },
  {
    why: "applies_to is valid only on tool-call events",
    lines: [
      "hooks:",
      "  role_stop:",
      "    - command: echo hi",
      "      applies_to: [shell]",
    ],
  },
  {
    why: "unsupported reporting template",
    lines: ["reporting:", "  template: builtin:nope"],
  },
  {
    why: "unsupported finding filter strategy",
    lines: ["filtering:", "  findings: [builtin:nope]"],
  },
  {
    why: "execution mode outside the supported set",
    lines: ["execution:", "  mode: fanout"],
  },
];

test("a document the loader rejects is never one the published schema accepts", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "schema-drift-"));
  try {
    const dir = join(scratch, "harnesses", "drift");
    await mkdir(dir, { recursive: true });
    for (const entry of REJECTED_HARNESS_DOCUMENTS) {
      const source = [
        'spec_version: "0.3"',
        "kind: harness",
        "harness: { id: drift }",
        entry.roles ?? "roles: { a: { description: A } }",
        ...entry.lines,
      ].join("\n");
      await writeFile(join(dir, "harness.yaml"), source);

      let loaderRejected = false;
      try {
        await loadHarness({ agentsDir: scratch, harnessId: "drift" });
      } catch {
        loaderRejected = true;
      }
      expect([entry.why, "loader rejects", loaderRejected]).toEqual([
        entry.why,
        "loader rejects",
        true,
      ]);

      const violations = findAllSchemaViolations(Bun.YAML.parse(source));
      expect([entry.why, "schema rejects", violations.length > 0]).toEqual([
        entry.why,
        "schema rejects",
        true,
      ]);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a policy the loader rejects is never one the published schema accepts", async () => {
  const rejected: readonly (readonly [string, readonly string[]])[] = [
    ["unknown key", ["capabilties:", "  exec: { deny: ['*'] }"]],
    ["null capability list", ["capabilities:", "  exec:", "    deny:"]],
    ["non-numeric spend ceiling", ["limits:", "  cost_usd: '2.5'"]],
    ["unknown confirmation category", ["confirmations:", "  requiredFor: [x]"]],
  ];
  const scratch = await mkdtemp(join(tmpdir(), "schema-drift-"));
  try {
    await mkdir(join(scratch, "harnesses", "policied"), { recursive: true });
    await mkdir(join(scratch, "policies"), { recursive: true });
    await writeFile(
      join(scratch, "harnesses", "policied", "harness.yaml"),
      [
        'spec_version: "0.3"',
        "kind: harness",
        "harness: { id: policied }",
        "policy: guard",
        "roles: { a: { description: A } }",
      ].join("\n"),
    );
    for (const [why, lines] of rejected) {
      const source = ["id: guard", ...lines].join("\n");
      await writeFile(join(scratch, "policies", "guard.yaml"), source);

      let loaderRejected = false;
      try {
        await loadHarness({ agentsDir: scratch, harnessId: "policied" });
      } catch {
        loaderRejected = true;
      }
      expect([why, "loader rejects", loaderRejected]).toEqual([
        why,
        "loader rejects",
        true,
      ]);

      const violations = findAllSchemaViolations(
        Bun.YAML.parse(source),
        POLICY_SCHEMA,
      );
      expect([why, "schema rejects", violations.length > 0]).toEqual([
        why,
        "schema rejects",
        true,
      ]);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
