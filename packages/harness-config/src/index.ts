import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ExecutionConfig,
  HarnessDefinition,
  RoleDefinition,
} from "@aguil/agents-orchestration";
import {
  REPORT_TEMPLATE_NAMES,
  type ReportTemplateName,
} from "@aguil/agents-reporting";
import { evaluate, parse } from "@marcbachmann/cel-js";

export type {
  ApplyFindingPipelinesConfig,
  OutcomeSchemaViolation,
} from "./output-pipeline";
export {
  applyFindingPipelines,
  validateOutcomesAgainstSchemas,
} from "./output-pipeline";
export type { JsonSchema } from "./schema-validation";
export {
  findAllSchemaViolations,
  HARNESS_SCHEMA,
  MANIFEST_SCHEMA,
  POLICY_SCHEMA,
  validateHarnessDocument,
  validateManifestDocument,
  validatePolicyDocument,
} from "./schema-validation";

import {
  validateHarnessDocument,
  validateManifestDocument,
  validatePolicyDocument,
} from "./schema-validation";

export const HARNESS_SPEC_VERSION = "0.3";

/**
 * Accepted `spec_version` values. Every increment so far is additive — v0.2
 * added per-handler `applies_to` event classes, v0.3 added role `ref:` — so
 * documents declaring an older version remain loadable unchanged.
 */
export const SUPPORTED_SPEC_VERSIONS: readonly string[] = ["0.1", "0.2", "0.3"];

/** Capability constraint lists (carried here, enforced by the policy layer). */
export interface PolicyCapabilityRules {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

/** Action categories that route to approval instead of a hard verdict. */
export const POLICY_CONFIRMATION_CATEGORIES = [
  "exec.unknown",
  "filesystem.write",
] as const;

export type PolicyConfirmationCategory =
  (typeof POLICY_CONFIRMATION_CATEGORIES)[number];

export interface PolicySpec {
  readonly id: string;
  readonly description?: string;
  readonly capabilities?: {
    readonly filesystem?: PolicyCapabilityRules;
    readonly exec?: PolicyCapabilityRules;
    readonly network?: PolicyCapabilityRules;
  };
  readonly limits?: {
    readonly costUsd?: number;
    readonly timeoutMs?: number;
  };
  readonly confirmations?: {
    readonly requiredFor: readonly PolicyConfirmationCategory[];
  };
}

const CONFIRMATION_CATEGORIES: ReadonlySet<string> = new Set(
  POLICY_CONFIRMATION_CATEGORIES,
);

export const HOOK_EVENTS = [
  "pre_tool_call",
  "post_tool_call",
  "role_start",
  "role_stop",
  "run_start",
  "run_end",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Adapter-level classes a tool-call hook can scope itself to (spec v0.2).
 * The canonical pre/post_tool_call events are coarser than what authors
 * often mean: a shell-only handler registered on every projection wastes a
 * process spawn per MCP call (#71). `applies_to` records the author's
 * intent explicitly instead of interpreting matcher regexes heuristically —
 * silent under-registration of a policy-adjacent hook is the wrong failure
 * mode, so absence still means "all classes".
 */
export const HOOK_EVENT_CLASSES = ["shell", "mcp", "edit"] as const;

export type HookEventClass = (typeof HOOK_EVENT_CLASSES)[number];

/** Command handler — the only handler type in spec v0.1/v0.2. */
export interface HookHandlerSpec {
  readonly command: string;
  /** Regex over tool names (e.g. "Execute", "Create|Edit"). */
  readonly matcher?: string;
  readonly timeoutS?: number;
  /**
   * Event classes this handler registers on (spec v0.2, tool-call events
   * only). Absent = every class the canonical event projects to.
   */
  readonly appliesTo?: readonly HookEventClass[];
}

export type HooksSpec = Readonly<
  Partial<Record<HookEvent, readonly HookHandlerSpec[]>>
>;

export interface HarnessManifest {
  readonly specVersion?: string;
  readonly enabledHarnesses: readonly string[];
}

export interface ContextProviderSpec {
  readonly use: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export type BuiltinOutcomeSchema = "builtin:finding";

export interface RecordOutcomeSchema {
  readonly required?: readonly string[];
  readonly dataRequired?: readonly string[];
}

export type OutcomeSchema = BuiltinOutcomeSchema | RecordOutcomeSchema;
export type OutputSchemas = Readonly<Record<string, OutcomeSchema>>;

export type FindingFilterStrategy = "builtin:actionable";
export type FindingDeduperStrategy = "builtin:fingerprint";

export interface LoadedHarness {
  readonly definition: HarnessDefinition;
  /** Harness-level default policy (when `policy:` is declared). */
  readonly policy?: PolicySpec;
  /**
   * Effective policy per role id: the role's own `policy:` reference when
   * declared, otherwise the harness-level default. Roles absent from this
   * map have no policy at all.
   */
  readonly rolePolicies: Readonly<Record<string, PolicySpec>>;
  readonly hooks: HooksSpec;
  readonly contextProviders?: readonly ContextProviderSpec[];
  readonly outputSchemas?: OutputSchemas;
  readonly findingFilters?: readonly FindingFilterStrategy[];
  readonly findingDedupers?: readonly FindingDeduperStrategy[];
  readonly reportingTemplate?: ReportTemplateName;
  /** Directory containing harness.yaml (prompt paths resolve against it). */
  readonly harnessDir: string;
}

export interface LoadHarnessOptions {
  /** Absolute or cwd-relative path to the `.agents/` directory. */
  readonly agentsDir: string;
  readonly harnessId: string;
}

export interface RoleEnablementEnv {
  /** Triage tier and any other scalar bindings exposed to expressions. */
  readonly [key: string]: string | number | boolean;
}

export interface RoleEnablementResult {
  readonly definition: HarnessDefinition;
  readonly disabledRoleIds: readonly string[];
}

class HarnessConfigError extends Error {}

function fail(message: string): never {
  throw new HarnessConfigError(`harness-config: ${message}`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  const parsed = optionalString(value, label);
  if (parsed === undefined) {
    fail(`${label} is required`);
  }
  return parsed;
}

function optionalPositiveInt(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

/**
 * A spend ceiling that is not a positive finite number used to be dropped
 * silently, which turned a typo into an absent limit — the fail-open direction,
 * in a document whose whole purpose is to constrain. `NaN` in particular
 * compares false against every threshold, so it read as "no limit".
 */
function optionalPositiveNumber(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive number`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    fail(`${label} must be a list of strings`);
  }
  return value as readonly string[];
}

function nonEmptyStringList(value: unknown, label: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    fail(`${label} must be a non-empty list of non-empty strings`);
  }
  return value as readonly string[];
}

async function readYamlFile(path: string, label: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    fail(
      `${label} not readable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return Bun.YAML.parse(raw);
  } catch (error) {
    fail(
      `${label} at ${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Structural validation, run before any semantic check: the schema rejects
 * unknown and misplaced keys, which the hand-rolled checks cannot, and its
 * failures are the ones most likely to explain a document that "parses but
 * does nothing". Semantic checks the schema cannot express still run after.
 */
function assertMatchesSchema(problems: readonly string[], label: string): void {
  if (problems.length > 0) {
    fail(`${label} does not match its schema:\n  - ${problems.join("\n  - ")}`);
  }
}

function assertSupportedSpecVersion(
  version: string | undefined,
  label: string,
): void {
  if (version !== undefined && !SUPPORTED_SPEC_VERSIONS.includes(version)) {
    fail(
      `unsupported ${label} "${version}" (supported: ${SUPPORTED_SPEC_VERSIONS.join(", ")})`,
    );
  }
}

/** Read `.agents/manifest.yaml`; missing file yields an empty manifest. */
export async function loadManifest(
  agentsDir: string,
): Promise<HarnessManifest> {
  const path = join(resolve(agentsDir), "manifest.yaml");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { enabledHarnesses: [] };
  }
  const parsed = asRecord(Bun.YAML.parse(raw) ?? {}, "manifest.yaml");
  assertMatchesSchema(validateManifestDocument(parsed), "manifest.yaml");
  const enabled = asRecord(parsed.enabled ?? {}, "manifest.yaml enabled");
  const specVersion = optionalString(
    parsed.specVersion,
    "manifest.specVersion",
  );
  assertSupportedSpecVersion(specVersion, "manifest specVersion");
  return {
    specVersion,
    enabledHarnesses:
      optionalStringArray(enabled.harnesses, "manifest.enabled.harnesses") ??
      [],
  };
}

function parsePolicy(value: unknown, id: string): PolicySpec {
  const record = asRecord(value, `policy ${id}`);
  assertMatchesSchema(validatePolicyDocument(record), `policy "${id}"`);
  const declaredId = optionalString(record.id, `policy ${id} id`);
  if (declaredId !== undefined && declaredId !== id) {
    fail(`policy file for "${id}" declares mismatched id "${declaredId}"`);
  }
  const capabilities =
    record.capabilities === undefined
      ? undefined
      : asRecord(record.capabilities, `policy ${id} capabilities`);
  const parseRules = (
    label: string,
    value: unknown,
  ): PolicyCapabilityRules | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const rules = asRecord(value, label);
    return {
      allow: optionalStringArray(rules.allow, `${label}.allow`),
      deny: optionalStringArray(rules.deny, `${label}.deny`),
    };
  };
  const limits =
    record.limits === undefined
      ? undefined
      : asRecord(record.limits, `policy ${id} limits`);
  const confirmations =
    record.confirmations === undefined
      ? undefined
      : asRecord(record.confirmations, `policy ${id} confirmations`);
  const requiredFor =
    confirmations === undefined
      ? undefined
      : (optionalStringArray(
          confirmations.requiredFor ?? confirmations.required_for,
          `policy ${id} confirmations.requiredFor`,
        ) ?? []);
  if (requiredFor !== undefined) {
    for (const category of requiredFor) {
      if (!CONFIRMATION_CATEGORIES.has(category)) {
        fail(
          `policy ${id} confirmations.requiredFor has unknown category "${category}" (supported: ${[...CONFIRMATION_CATEGORIES].join(", ")})`,
        );
      }
    }
  }
  return {
    id,
    description: optionalString(record.description, `policy ${id} description`),
    ...(capabilities === undefined
      ? {}
      : {
          capabilities: {
            filesystem: parseRules(
              `policy ${id} capabilities.filesystem`,
              capabilities.filesystem,
            ),
            exec: parseRules(
              `policy ${id} capabilities.exec`,
              capabilities.exec,
            ),
            network: parseRules(
              `policy ${id} capabilities.network`,
              capabilities.network,
            ),
          },
        }),
    ...(limits === undefined
      ? {}
      : {
          limits: {
            costUsd: optionalPositiveNumber(
              limits.cost_usd,
              `policy ${id} limits.cost_usd`,
            ),
            timeoutMs: optionalPositiveInt(
              limits.timeout_ms,
              `policy ${id} limits.timeout_ms`,
            ),
          },
        }),
    ...(requiredFor === undefined
      ? {}
      : {
          confirmations: {
            requiredFor: requiredFor as readonly PolicyConfirmationCategory[],
          },
        }),
  };
}

const ROLE_FIELDS: ReadonlySet<string> = new Set([
  "description",
  "enabled",
  "prompt",
  "prompt_path",
  "timeout_ms",
  "allowed_commands",
  "required_capabilities",
  "policy",
]);

/**
 * Frontmatter keys accepted in a role file. `prompt` and `prompt_path` are
 * excluded deliberately: the Markdown body below the frontmatter is the
 * prompt, so a role file has no need to point elsewhere for one.
 */
const ROLE_FILE_FIELDS: ReadonlySet<string> = new Set(
  [...ROLE_FIELDS].filter(
    (field) => field !== "prompt" && field !== "prompt_path",
  ),
);

interface ParsedRole {
  readonly role: RoleDefinition;
  readonly policyId?: string;
}

/** A role defined as `.agents/agents/<id>/agent.md`, before harness overrides. */
export interface RoleFile {
  readonly frontMatter: Record<string, unknown>;
  readonly prompt: string;
}

/**
 * Apply a `ref:` to a harness role entry. Role files are only consulted when
 * referenced — a file never shadows a role the harness declares itself — and
 * sibling keys on the referencing entry override the file's frontmatter, so
 * the harness always wins where it states an opinion.
 */
function resolveRoleRef(
  roleId: string,
  declared: Record<string, unknown>,
  roleFiles: ReadonlyMap<string, RoleFile>,
): Record<string, unknown> {
  if (declared.ref === undefined) {
    return declared;
  }
  const ref = requiredString(declared.ref, `role ${roleId} ref`);
  const roleFile = roleFiles.get(ref);
  if (roleFile === undefined) {
    // Unreachable: every declared ref is loaded before roles are parsed.
    fail(`role ${roleId} references unresolved role file "${ref}"`);
  }
  const { ref: _ref, ...overrides } = declared;
  const merged: Record<string, unknown> = {
    ...roleFile.frontMatter,
    ...overrides,
  };
  if (merged.prompt === undefined && merged.prompt_path === undefined) {
    merged.prompt = roleFile.prompt;
  }
  return merged;
}

/**
 * Split `---` frontmatter from the Markdown body of a role file. The body is
 * the role's prompt.
 */
function parseRoleFile(source: string, label: string): RoleFile {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    fail(`${label} must begin with a "---" frontmatter delimiter`);
  }
  // A delimiter is a line of exactly "---"; "---oops" is a malformed one
  // rather than a terminator, so it must not close the block.
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    fail(`${label} frontmatter is not terminated by a closing "---"`);
  }
  const frontMatterSource = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(frontMatterSource);
  } catch (error) {
    fail(
      `${label} frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const frontMatter = asRecord(parsed ?? {}, `${label} frontmatter`);
  const unknownKeys = Object.keys(frontMatter).filter(
    (key) => !ROLE_FILE_FIELDS.has(key),
  );
  if (unknownKeys.length > 0) {
    fail(
      `${label} has unsupported frontmatter fields: ${unknownKeys.join(", ")} (supported: ${[...ROLE_FILE_FIELDS].join(", ")})`,
    );
  }
  const prompt = body.trim();
  if (prompt.length === 0) {
    fail(`${label} has an empty body; the body is the role prompt`);
  }
  return { frontMatter, prompt };
}

/** Role file ids present under `.agents/agents/`, for error messages only. */
async function listRoleFileIds(rolesDir: string): Promise<readonly string[]> {
  try {
    return [...(await readdir(rolesDir))].sort();
  } catch {
    return [];
  }
}

/**
 * Load the repo-scoped role files a harness actually references, from
 * `.agents/agents/<id>/agent.md`. Resolution is by reference only, so an
 * unreferenced role file is never read and cannot break an unrelated harness.
 */
export async function loadReferencedRoleFiles(
  agentsDir: string,
  refs: Iterable<string>,
): Promise<ReadonlyMap<string, RoleFile>> {
  const rolesDir = join(resolve(agentsDir), "agents");
  const ids = [...new Set(refs)];
  for (const id of ids) {
    assertValidIdToken("role", id);
  }
  // Independent reads, so latency is one round trip rather than the sum.
  const reads = await Promise.all(
    ids.map(async (id) => {
      try {
        return {
          source: await readFile(join(rolesDir, id, "agent.md"), "utf8"),
        };
      } catch (error) {
        return { error };
      }
    }),
  );
  const roleFiles = new Map<string, RoleFile>();
  for (const [index, id] of ids.entries()) {
    const read = reads[index];
    if (read.source === undefined) {
      const path = `agents/${id}/agent.md`;
      // Only a genuinely absent file is a reference mistake; anything else
      // (permissions, a directory in the way) must report its own cause.
      if (
        (read.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT"
      ) {
        fail(
          `role file "${id}" not readable at ${path}: ${read.error instanceof Error ? read.error.message : String(read.error)}`,
        );
      }
      const available = await listRoleFileIds(rolesDir);
      fail(
        `role file "${id}" not found at ${path} (available: ${available.length === 0 ? "none" : available.join(", ")})`,
      );
    }
    roleFiles.set(id, parseRoleFile(read.source, `role file "${id}"`));
  }
  return roleFiles;
}

/** Collect the `ref:` values a harness `roles:` record declares. */
function collectRoleRefs(
  roleEntries: readonly (readonly [string, unknown])[],
): readonly string[] {
  const refs: string[] = [];
  for (const [roleId, value] of roleEntries) {
    const record = asRecord(value, `role ${roleId}`);
    if (record.ref !== undefined) {
      refs.push(requiredString(record.ref, `role ${roleId} ref`));
    }
  }
  return refs;
}

function parseRole(
  roleId: string,
  value: unknown,
  harnessDir: string,
  roleFiles: ReadonlyMap<string, RoleFile>,
): ParsedRole {
  // A role id becomes a path segment under the run scratchpad, so it is
  // constrained here as well as in the schema — the loader must hold this
  // regardless of which subset of schema failures the runtime reports.
  assertValidIdToken("role", roleId);
  const declared = asRecord(value, `role ${roleId}`);
  const record = resolveRoleRef(roleId, declared, roleFiles);
  const unknownKeys = Object.keys(record).filter(
    (key) => !ROLE_FIELDS.has(key),
  );
  if (unknownKeys.length > 0) {
    fail(
      `role ${roleId} has unsupported fields: ${unknownKeys.join(", ")} (supported: ${["ref", ...ROLE_FIELDS].join(", ")})`,
    );
  }
  const policyId = optionalString(record.policy, `role ${roleId} policy`);
  if (policyId !== undefined) {
    assertValidPolicyId(policyId);
  }
  let enabledWhen: string | undefined;
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== "string" || record.enabled.length === 0) {
      fail(`role ${roleId} enabled must be a non-empty string`);
    }
    enabledWhen = record.enabled;
  }
  if (enabledWhen !== undefined) {
    try {
      parse(enabledWhen);
    } catch (error) {
      fail(
        `role ${roleId} enabled expression is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const prompt = optionalString(record.prompt, `role ${roleId} prompt`);
  const promptPathRaw = optionalString(
    record.prompt_path,
    `role ${roleId} prompt_path`,
  );
  if (prompt !== undefined && promptPathRaw !== undefined) {
    fail(`role ${roleId} sets both prompt and prompt_path`);
  }
  const promptPath =
    promptPathRaw === undefined
      ? undefined
      : isAbsolute(promptPathRaw)
        ? promptPathRaw
        : join(harnessDir, promptPathRaw);
  const role: RoleDefinition = {
    id: roleId,
    description: requiredString(
      record.description,
      `role ${roleId} description`,
    ),
    ...(prompt === undefined ? {} : { prompt }),
    ...(promptPath === undefined ? {} : { promptPath }),
    ...(enabledWhen === undefined ? {} : { enabledWhen }),
    requiredCapabilities:
      optionalStringArray(
        record.required_capabilities,
        `role ${roleId} required_capabilities`,
      ) ?? [],
    timeoutMs:
      optionalPositiveInt(record.timeout_ms, `role ${roleId} timeout_ms`) ??
      600_000,
    ...(record.allowed_commands === undefined
      ? {}
      : {
          allowedCommands: optionalStringArray(
            record.allowed_commands,
            `role ${roleId} allowed_commands`,
          ),
        }),
  };
  return { role, ...(policyId === undefined ? {} : { policyId }) };
}

function parseExecution(
  value: unknown,
  roleIds: ReadonlySet<string>,
): ExecutionConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, "execution");
  const mode = requiredString(record.mode, "execution.mode");
  const requireRoles = (
    label: string,
    ids: readonly string[] | undefined,
  ): readonly string[] => {
    if (ids === undefined || ids.length === 0) {
      fail(`${label} must list at least one role`);
    }
    for (const id of ids) {
      if (!roleIds.has(id)) {
        fail(`${label} references unknown role "${id}"`);
      }
    }
    return ids;
  };
  switch (mode) {
    case "parallel":
      return { mode: "parallel" };
    case "chain": {
      const order = optionalStringArray(record.order, "execution.order");
      if (order !== undefined) {
        requireRoles("execution.order", order);
      }
      const passCheck = optionalStringArray(
        record.pass_check,
        "execution.pass_check",
      );
      if (passCheck !== undefined && passCheck.length === 0) {
        fail("execution.pass_check must list at least one command token");
      }
      return {
        mode: "chain",
        ...(order === undefined ? {} : { order }),
        ...(passCheck === undefined ? {} : { passCheck }),
      };
    }
    case "validation-loop": {
      return {
        mode: "validation-loop",
        implementationRoles: requireRoles(
          "execution.implementation_roles",
          optionalStringArray(
            record.implementation_roles,
            "execution.implementation_roles",
          ),
        ),
        validationRoles: requireRoles(
          "execution.validation_roles",
          optionalStringArray(
            record.validation_roles,
            "execution.validation_roles",
          ),
        ),
        maxRounds:
          optionalPositiveInt(record.max_rounds, "execution.max_rounds") ?? 1,
      };
    }
    default:
      fail(
        `execution.mode "${mode}" is not supported (parallel, chain, validation-loop)`,
      );
  }
}

export function filterEnabledRoles(
  definition: HarnessDefinition,
  env: RoleEnablementEnv,
): RoleEnablementResult {
  const disabledRoleIds: string[] = [];
  const roles = definition.roles.filter((role) => {
    if (role.enabledWhen === undefined) {
      return true;
    }

    let result: unknown;
    try {
      result = evaluate(role.enabledWhen, env);
    } catch (error) {
      throw new Error(
        `role "${role.id}" enablement evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof result !== "boolean") {
      throw new Error(
        `role "${role.id}" enablement expression returned ${typeof result}, expected boolean`,
      );
    }
    if (!result) {
      disabledRoleIds.push(role.id);
    }
    return result;
  });

  if (roles.length === 0) {
    throw new Error(
      `harness "${definition.id}" has no enabled roles for the evaluation environment`,
    );
  }

  const disabledRoleIdSet = new Set(disabledRoleIds);
  let execution = definition.execution;
  if (execution?.mode === "chain" && execution.order !== undefined) {
    execution = {
      ...execution,
      order: execution.order.filter((roleId) => !disabledRoleIdSet.has(roleId)),
    };
  } else if (execution?.mode === "validation-loop") {
    const disabledParticipants = [
      ...execution.implementationRoles,
      ...execution.validationRoles,
    ].filter((roleId) => disabledRoleIdSet.has(roleId));
    if (disabledParticipants.length > 0) {
      throw new Error(
        `harness "${definition.id}" validation-loop references disabled role${disabledParticipants.length === 1 ? "" : "s"}: ${[...new Set(disabledParticipants)].join(", ")}`,
      );
    }
  }

  return {
    definition: {
      ...definition,
      roles,
      ...(execution === undefined ? {} : { execution }),
    },
    disabledRoleIds,
  };
}

function parseAppliesTo(
  value: unknown,
  event: string,
  index: number,
): { readonly appliesTo?: readonly HookEventClass[] } {
  if (value === undefined) {
    return {};
  }
  const label = `hooks.${event}[${index}].applies_to`;
  if (event !== "pre_tool_call" && event !== "post_tool_call") {
    fail(`${label} is only valid on tool-call events`);
  }
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty list of event classes`);
  }
  const classes = value.map((entry) => {
    if (
      typeof entry !== "string" ||
      !(HOOK_EVENT_CLASSES as readonly string[]).includes(entry)
    ) {
      fail(`${label} entries must be one of: ${HOOK_EVENT_CLASSES.join(", ")}`);
    }
    return entry as HookEventClass;
  });
  return { appliesTo: classes };
}

function parseHooks(value: unknown, harnessDir: string): HooksSpec {
  if (value === undefined) {
    return {};
  }
  const record = asRecord(value, "hooks");
  const events = new Set<string>(HOOK_EVENTS);
  const hooks: Partial<Record<HookEvent, readonly HookHandlerSpec[]>> = {};
  for (const [event, handlersValue] of Object.entries(record)) {
    if (!events.has(event)) {
      fail(
        `hooks event "${event}" is not supported (${HOOK_EVENTS.join(", ")})`,
      );
    }
    if (!Array.isArray(handlersValue)) {
      fail(`hooks.${event} must be a list of handlers`);
    }
    hooks[event as HookEvent] = handlersValue.map((handlerValue, index) => {
      const handler = asRecord(handlerValue, `hooks.${event}[${index}]`);
      const unknownKeys = Object.keys(handler).filter(
        (key) =>
          !["command", "matcher", "timeout_s", "applies_to"].includes(key),
      );
      if (unknownKeys.length > 0) {
        fail(
          `hooks.${event}[${index}] has unsupported fields: ${unknownKeys.join(", ")} (spec v0.2 supports command handlers only)`,
        );
      }
      const commandRaw = requiredString(
        handler.command,
        `hooks.${event}[${index}].command`,
      );
      return {
        command: commandRaw.replaceAll("$HARNESS_DIR", harnessDir),
        ...(handler.matcher === undefined
          ? {}
          : {
              matcher: requiredString(
                handler.matcher,
                `hooks.${event}[${index}].matcher`,
              ),
            }),
        ...(handler.timeout_s === undefined
          ? {}
          : {
              timeoutS: optionalPositiveInt(
                handler.timeout_s,
                `hooks.${event}[${index}].timeout_s`,
              ),
            }),
        ...parseAppliesTo(handler.applies_to, event, index),
      };
    });
  }
  return hooks;
}

function parseContext(
  value: unknown,
): readonly ContextProviderSpec[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, "context");
  const unknownKeys = Object.keys(record).filter((key) => key !== "providers");
  if (unknownKeys.length > 0) {
    fail(
      `context has unsupported fields: ${unknownKeys.join(", ")} (supported: providers)`,
    );
  }
  if (!Array.isArray(record.providers) || record.providers.length === 0) {
    fail("context.providers must be a non-empty list");
  }
  return record.providers.map((value, index) => {
    const provider = asRecord(value, `context.providers[${index}]`);
    const use = requiredString(provider.use, `context.providers[${index}].use`);
    const { use: _use, ...params } = provider;
    return { use, params };
  });
}

const OUTPUT_SCHEMA_FIELDS: ReadonlySet<string> = new Set([
  "required",
  "data_required",
]);

function parseOutputSchemas(value: unknown): OutputSchemas | undefined {
  if (value === undefined) {
    return undefined;
  }
  const output = asRecord(value, "output");
  const outputUnknownKeys = Object.keys(output).filter(
    (key) => key !== "schemas",
  );
  if (outputUnknownKeys.length > 0) {
    fail(
      `output has unsupported fields: ${outputUnknownKeys.join(", ")} (supported: schemas)`,
    );
  }
  const schemas = asRecord(output.schemas, "output.schemas");
  const parsed: Record<string, OutcomeSchema> = {};
  for (const [kind, value] of Object.entries(schemas)) {
    assertValidIdToken("outcome kind", kind);
    const label = `output.schemas.${kind}`;
    if (typeof value === "string") {
      if (value !== "builtin:finding") {
        fail(
          `${label} has unknown builtin schema "${value}" (supported: builtin:finding)`,
        );
      }
      if (kind !== "finding") {
        fail(`${label} may use builtin:finding only for kind "finding"`);
      }
      parsed[kind] = value;
      continue;
    }

    const schema = asRecord(value, label);
    const unknownKeys = Object.keys(schema).filter(
      (key) => !OUTPUT_SCHEMA_FIELDS.has(key),
    );
    if (unknownKeys.length > 0) {
      fail(
        `${label} has unsupported fields: ${unknownKeys.join(", ")} (supported: required, data_required)`,
      );
    }
    parsed[kind] = {
      ...(schema.required === undefined
        ? {}
        : {
            required: nonEmptyStringList(schema.required, `${label}.required`),
          }),
      ...(schema.data_required === undefined
        ? {}
        : {
            dataRequired: nonEmptyStringList(
              schema.data_required,
              `${label}.data_required`,
            ),
          }),
    };
  }
  return parsed;
}

function parseFindingStrategies<T extends string>(
  value: unknown,
  section: string,
  supported: readonly T[],
): readonly T[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, section);
  const unknownKeys = Object.keys(record).filter((key) => key !== "findings");
  if (unknownKeys.length > 0) {
    fail(
      `${section} has unsupported fields: ${unknownKeys.join(", ")} (supported: findings)`,
    );
  }
  const strategies = nonEmptyStringList(record.findings, `${section}.findings`);
  for (const strategy of strategies) {
    if (!(supported as readonly string[]).includes(strategy)) {
      fail(
        `${section}.findings has unknown strategy "${strategy}" (supported: ${supported.join(", ")})`,
      );
    }
  }
  return strategies as readonly T[];
}

function parseReporting(value: unknown): ReportTemplateName | undefined {
  if (value === undefined) {
    return undefined;
  }
  const reporting = asRecord(value, "reporting");
  const unknownKeys = Object.keys(reporting).filter(
    (key) => key !== "template",
  );
  if (unknownKeys.length > 0) {
    fail(
      `reporting has unsupported fields: ${unknownKeys.join(", ")} (supported: template)`,
    );
  }
  const template = requiredString(reporting.template, "reporting.template");
  if (!(REPORT_TEMPLATE_NAMES as readonly string[]).includes(template)) {
    fail(
      `reporting.template has unknown template "${template}" (supported: ${REPORT_TEMPLATE_NAMES.join(", ")})`,
    );
  }
  return template as ReportTemplateName;
}

/**
 * Policy and harness ids become filesystem path segments (and, for policy
 * ids, shell command arguments), so they are restricted to a conservative
 * token grammar: no path separators, no `..`, no shell metacharacters.
 */
const ID_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertValidIdToken(kind: string, id: string): void {
  if (!ID_TOKEN_PATTERN.test(id) || id.includes("..")) {
    fail(
      `${kind} id "${id}" is invalid (allowed: letters, digits, '.', '_', '-'; must not contain path separators or '..')`,
    );
  }
}

export function assertValidPolicyId(policyId: string): void {
  assertValidIdToken("policy", policyId);
}

export function assertValidHarnessId(harnessId: string): void {
  assertValidIdToken("harness", harnessId);
}

/** Load and parse one policy from `.agents/policies/<id>.yaml`. */
export async function loadPolicy(
  agentsDir: string,
  policyId: string,
): Promise<PolicySpec> {
  assertValidPolicyId(policyId);
  return parsePolicy(
    await readYamlFile(
      join(resolve(agentsDir), "policies", `${policyId}.yaml`),
      `policy "${policyId}"`,
    ),
    policyId,
  );
}

/**
 * Load one harness definition from `.agents/harnesses/<id>/harness.yaml`,
 * resolving a `policy: <id>` reference against `.agents/policies/<id>.yaml`
 * and a role `ref: <id>` against `.agents/agents/<id>/agent.md`.
 * Single-file resolution only — no scopes/profiles/overlay merging.
 */
export async function loadHarness(
  options: LoadHarnessOptions,
): Promise<LoadedHarness> {
  assertValidHarnessId(options.harnessId);
  const agentsDir = resolve(options.agentsDir);
  const harnessDir = join(agentsDir, "harnesses", options.harnessId);
  const specPath = join(harnessDir, "harness.yaml");
  const parsed = asRecord(
    await readYamlFile(specPath, `harness "${options.harnessId}"`),
    "harness.yaml",
  );

  assertMatchesSchema(
    validateHarnessDocument(parsed),
    `harness "${options.harnessId}"`,
  );

  assertSupportedSpecVersion(
    requiredString(parsed.spec_version, "spec_version"),
    "spec_version",
  );
  if (parsed.kind !== "harness") {
    fail(`kind must be "harness"`);
  }
  const harness = asRecord(parsed.harness, "harness");
  const declaredId = requiredString(harness.id, "harness.id");
  if (declaredId !== options.harnessId) {
    fail(
      `harness.id "${declaredId}" does not match directory "${options.harnessId}"`,
    );
  }

  const rolesRecord = asRecord(parsed.roles, "roles");
  const roleEntries = Object.entries(rolesRecord);
  if (roleEntries.length === 0) {
    fail("roles must define at least one role");
  }
  const roleFiles = await loadReferencedRoleFiles(
    agentsDir,
    collectRoleRefs(roleEntries),
  );
  const parsedRoles = roleEntries.map(([roleId, value]) =>
    parseRole(roleId, value, harnessDir, roleFiles),
  );
  const roles = parsedRoles.map((parsedRole) => parsedRole.role);
  const roleIds = new Set(roles.map((role) => role.id));

  const execution = parseExecution(parsed.execution, roleIds);
  const hooks = parseHooks(parsed.hooks, harnessDir);
  const contextProviders = parseContext(parsed.context);
  const outputSchemas = parseOutputSchemas(parsed.output);
  const findingFilters = parseFindingStrategies(parsed.filtering, "filtering", [
    "builtin:actionable",
  ] as const);
  const findingDedupers = parseFindingStrategies(
    parsed.deduplication,
    "deduplication",
    ["builtin:fingerprint"] as const,
  );
  const reportingTemplate = parseReporting(parsed.reporting);

  const policyId = optionalString(parsed.policy, "policy");
  const policy =
    policyId === undefined ? undefined : await loadPolicy(agentsDir, policyId);

  // Resolve per-role policies (role override > harness default), reading
  // each referenced policy file once.
  const policyCache = new Map<string, PolicySpec>();
  if (policyId !== undefined && policy !== undefined) {
    policyCache.set(policyId, policy);
  }
  const rolePolicies: Record<string, PolicySpec> = {};
  for (const parsedRole of parsedRoles) {
    const effectiveId = parsedRole.policyId ?? policyId;
    if (effectiveId === undefined) {
      continue;
    }
    let resolved = policyCache.get(effectiveId);
    if (resolved === undefined) {
      resolved = await loadPolicy(agentsDir, effectiveId);
      policyCache.set(effectiveId, resolved);
    }
    rolePolicies[parsedRole.role.id] = resolved;
  }

  const definition: HarnessDefinition = {
    id: declaredId,
    roles,
    ...(execution === undefined ? {} : { execution }),
    ...(parsed.default_allowed_commands === undefined
      ? {}
      : {
          defaultAllowedCommands: optionalStringArray(
            parsed.default_allowed_commands,
            "default_allowed_commands",
          ),
        }),
  };

  return {
    definition,
    ...(policy === undefined ? {} : { policy }),
    rolePolicies,
    hooks,
    ...(contextProviders === undefined ? {} : { contextProviders }),
    ...(outputSchemas === undefined ? {} : { outputSchemas }),
    ...(findingFilters === undefined ? {} : { findingFilters }),
    ...(findingDedupers === undefined ? {} : { findingDedupers }),
    ...(reportingTemplate === undefined ? {} : { reportingTemplate }),
    harnessDir,
  };
}
