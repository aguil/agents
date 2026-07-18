import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ExecutionConfig,
  HarnessDefinition,
  RoleDefinition,
} from "@aguil/agents-orchestration";

export const HARNESS_SPEC_VERSION = "0.2";

/**
 * Accepted `spec_version` values. v0.2 is additive over v0.1 (per-handler
 * `applies_to` event classes), so v0.1 documents remain loadable unchanged.
 */
export const SUPPORTED_SPEC_VERSIONS: readonly string[] = ["0.1", "0.2"];

/** AGENTS-1-style capability constraint lists (carried, not enforced here). */
export interface PolicyCapabilityRules {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

/** Action categories that route to approval instead of a hard verdict. */
export type PolicyConfirmationCategory = "exec.unknown" | "filesystem.write";

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

const CONFIRMATION_CATEGORIES: ReadonlySet<string> = new Set([
  "exec.unknown",
  "filesystem.write",
]);

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
  /** Directory containing harness.yaml (prompt paths resolve against it). */
  readonly harnessDir: string;
}

export interface LoadHarnessOptions {
  /** Absolute or cwd-relative path to the `.agents/` directory. */
  readonly agentsDir: string;
  readonly harnessId: string;
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
  const enabled = asRecord(parsed.enabled ?? {}, "manifest.yaml enabled");
  return {
    specVersion: optionalString(parsed.specVersion, "manifest.specVersion"),
    enabledHarnesses:
      optionalStringArray(enabled.harnesses, "manifest.enabled.harnesses") ??
      [],
  };
}

function parsePolicy(value: unknown, id: string): PolicySpec {
  const record = asRecord(value, `policy ${id}`);
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
            costUsd:
              typeof limits.cost_usd === "number" ? limits.cost_usd : undefined,
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
  "prompt",
  "prompt_path",
  "timeout_ms",
  "allowed_commands",
  "required_capabilities",
  "policy",
]);

interface ParsedRole {
  readonly role: RoleDefinition;
  readonly policyId?: string;
}

function parseRole(
  roleId: string,
  value: unknown,
  harnessDir: string,
): ParsedRole {
  const record = asRecord(value, `role ${roleId}`);
  const unknownKeys = Object.keys(record).filter(
    (key) => !ROLE_FIELDS.has(key),
  );
  if (unknownKeys.length > 0) {
    fail(
      `role ${roleId} has unsupported fields: ${unknownKeys.join(", ")} (supported: ${[...ROLE_FIELDS].join(", ")})`,
    );
  }
  const policyId = optionalString(record.policy, `role ${roleId} policy`);
  if (policyId !== undefined) {
    assertValidPolicyId(policyId);
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
 * resolving a `policy: <id>` reference against `.agents/policies/<id>.yaml`.
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

  const specVersion = requiredString(parsed.spec_version, "spec_version");
  if (!SUPPORTED_SPEC_VERSIONS.includes(specVersion)) {
    fail(
      `unsupported spec_version "${specVersion}" (supported: ${SUPPORTED_SPEC_VERSIONS.join(", ")})`,
    );
  }
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
  const parsedRoles = roleEntries.map(([roleId, value]) =>
    parseRole(roleId, value, harnessDir),
  );
  const roles = parsedRoles.map((parsedRole) => parsedRole.role);
  const roleIds = new Set(roles.map((role) => role.id));

  const execution = parseExecution(parsed.execution, roleIds);
  const hooks = parseHooks(parsed.hooks, harnessDir);
  const contextProviders = parseContext(parsed.context);

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
    harnessDir,
  };
}
