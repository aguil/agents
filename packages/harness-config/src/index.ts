import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ExecutionConfig,
  HarnessDefinition,
  RoleDefinition,
} from "@aguil/agents-orchestration";

export const HARNESS_SPEC_VERSION = "0.1";

/** AGENTS-1-style capability constraint lists (carried, not enforced here). */
export interface PolicyCapabilityRules {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}

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
}

export interface HarnessManifest {
  readonly specVersion?: string;
  readonly enabledHarnesses: readonly string[];
}

export interface LoadedHarness {
  readonly definition: HarnessDefinition;
  readonly policy?: PolicySpec;
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
  };
}

function parseRole(
  roleId: string,
  value: unknown,
  harnessDir: string,
): RoleDefinition {
  const record = asRecord(value, `role ${roleId}`);
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
  return {
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
      return { mode: "chain", ...(order === undefined ? {} : { order }) };
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

/**
 * Load one harness definition from `.agents/harnesses/<id>/harness.yaml`,
 * resolving a `policy: <id>` reference against `.agents/policies/<id>.yaml`.
 * Single-file resolution only — no scopes/profiles/overlay merging.
 */
export async function loadHarness(
  options: LoadHarnessOptions,
): Promise<LoadedHarness> {
  const agentsDir = resolve(options.agentsDir);
  const harnessDir = join(agentsDir, "harnesses", options.harnessId);
  const specPath = join(harnessDir, "harness.yaml");
  const parsed = asRecord(
    await readYamlFile(specPath, `harness "${options.harnessId}"`),
    "harness.yaml",
  );

  const specVersion = requiredString(parsed.spec_version, "spec_version");
  if (specVersion !== HARNESS_SPEC_VERSION) {
    fail(
      `unsupported spec_version "${specVersion}" (expected "${HARNESS_SPEC_VERSION}")`,
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
  const roles = roleEntries.map(([roleId, value]) =>
    parseRole(roleId, value, harnessDir),
  );
  const roleIds = new Set(roles.map((role) => role.id));

  const execution = parseExecution(parsed.execution, roleIds);

  const policyId = optionalString(parsed.policy, "policy");
  const policy =
    policyId === undefined
      ? undefined
      : parsePolicy(
          await readYamlFile(
            join(agentsDir, "policies", `${policyId}.yaml`),
            `policy "${policyId}"`,
          ),
          policyId,
        );

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
    harnessDir,
  };
}
