import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliOptions, ParsedCodeReviewArgv } from "./code-review-cli-models";

const ENV_PREFIX = "AGENTS_CODE_REVIEW_";

/** Partial options extracted from JSON or environment (subset of CliOptions). */
export type CodeReviewMergedPartial = Partial<CliOptions>;

const STRING_FIELDS: readonly (keyof CliOptions & string)[] = [
  "workspace",
  "scratchpad",
  "contextBundle",
  "result",
  "consensus",
  "adapter",
  "model",
  "variant",
  "agent",
  "opencode",
  "claude",
  "claudeArgs",
  "cursor",
  "cursorArgs",
  "cursorMode",
  "log",
  "pr",
  "postPr",
  "reviewSummary",
];

const BOOLEAN_FIELDS: readonly (keyof CliOptions & string)[] = [
  "dryRun",
  "postOnly",
  "noConfirm",
  "replacePendingReview",
  "noDeterministic",
  "strict",
  "pendingReview",
  "pure",
  "printLogs",
];

const ENV_TO_FIELD: Readonly<Record<string, keyof CliOptions>> = {
  WORKSPACE: "workspace",
  SCRATCHPAD: "scratchpad",
  CONTEXT_BUNDLE: "contextBundle",
  RESULT: "result",
  CONSENSUS: "consensus",
  ADAPTER: "adapter",
  MODEL: "model",
  VARIANT: "variant",
  AGENT: "agent",
  OPENCODE: "opencode",
  CLAUDE: "claude",
  CLAUDE_ARGS: "claudeArgs",
  CURSOR: "cursor",
  CURSOR_ARGS: "cursorArgs",
  CURSOR_MODE: "cursorMode",
  LOG: "log",
  PR: "pr",
  POST_PR: "postPr",
  REVIEW_SUMMARY: "reviewSummary",
  DRY_RUN: "dryRun",
  POST_ONLY: "postOnly",
  NO_CONFIRM: "noConfirm",
  REPLACE_PENDING_REVIEW: "replacePendingReview",
  NO_DETERMINISTIC: "noDeterministic",
  STRICT: "strict",
  PENDING_REVIEW: "pendingReview",
  PURE: "pure",
  PRINT_LOGS: "printLogs",
};

export function resolveUserCodeReviewConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "agents", "code-review", "config.json");
}

export function resolveRepoCodeReviewConfigPath(workspacePath: string): string {
  return join(workspacePath, ".review-agent", "config.json");
}

export function mergeFlatConfigLayers(base: CodeReviewMergedPartial, overlay: CodeReviewMergedPartial): CodeReviewMergedPartial {
  const next: CodeReviewMergedPartial = { ...base };
  for (const key of STRING_FIELDS) {
    const v = overlay[key];
    if (typeof v === "string") {
      (next as Record<string, unknown>)[key as string] = v;
    }
  }
  for (const key of BOOLEAN_FIELDS) {
    const v = overlay[key];
    if (typeof v === "boolean") {
      (next as Record<string, unknown>)[key as string] = v;
    }
  }
  return next;
}

export function mergePresetMaps(
  userPresets: Readonly<Record<string, CodeReviewMergedPartial>>,
  repoPresets: Readonly<Record<string, CodeReviewMergedPartial>>,
): Record<string, CodeReviewMergedPartial> {
  const names = new Set([...Object.keys(userPresets), ...Object.keys(repoPresets)]);
  const out: Record<string, CodeReviewMergedPartial> = {};
  for (const name of names) {
    const u = userPresets[name] ?? {};
    const r = repoPresets[name] ?? {};
    out[name] = mergeFlatConfigLayers(u, r);
  }
  return out;
}

function parseBooleanJson(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseStringJson(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractFlatFields(raw: Record<string, unknown>): CodeReviewMergedPartial {
  const out: CodeReviewMergedPartial = {};
  for (const field of STRING_FIELDS) {
    if (field in raw) {
      const s = parseStringJson(raw[field]);
      if (s !== undefined && s.length > 0) {
        (out as Record<string, unknown>)[field] = s;
      }
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (!(field in raw)) {
      continue;
    }
    const b = parseBooleanJson(raw[field]);
    if (b !== undefined) {
      (out as Record<string, unknown>)[field] = b;
    }
  }
  return out;
}

export function extractConfigDocument(raw: unknown):
  | { ok: false; error: string }
  | {
      ok: true;
      readonly flat: CodeReviewMergedPartial;
      readonly presets: Record<string, CodeReviewMergedPartial>;
    } {
  if (raw === undefined) {
    return { ok: true, flat: {}, presets: {} };
  }
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "Config root must be a JSON object" };
  }
  const root = raw as Record<string, unknown>;
  let presetsRaw = root.presets;
  if (presetsRaw !== undefined && (typeof presetsRaw !== "object" || presetsRaw === null)) {
    return { ok: false, error: "`presets` must be an object mapping preset names to partial option objects" };
  }
  const presetsSource = presetsRaw !== undefined ? (presetsRaw as Record<string, unknown>) : {};

  const flatSource = { ...root };
  delete flatSource.presets;

  const flat = extractFlatFields(flatSource);
  const presets: Record<string, CodeReviewMergedPartial> = {};
  for (const name of Object.keys(presetsSource)) {
    const body = presetsSource[name];
    if (typeof body !== "object" || body === null) {
      return { ok: false, error: `Preset '${name}' must be an object` };
    }
    const nestedPresets = (body as Record<string, unknown>).presets;
    if (nestedPresets !== undefined) {
      return { ok: false, error: `Preset '${name}' must not declare nested 'presets'` };
    }
    presets[name] = extractFlatFields(body as Record<string, unknown>);
  }
  return { ok: true, flat, presets };
}

async function loadConfigAt(path: string): Promise<
  | { ok: false; error: string; path: string }
  | { ok: true; flat: CodeReviewMergedPartial; presets: Record<string, CodeReviewMergedPartial>; path?: string }
> {
  try {
    await access(path);
  } catch (error: unknown) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return { ok: true, flat: {}, presets: {} };
    }
    return {
      ok: false,
      error: errno.message ?? String(error),
      path,
    };
  }
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    const parsed = extractConfigDocument(raw);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, path };
    }
    return { ok: true, flat: parsed.flat, presets: parsed.presets, path };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: message.startsWith("[") ? `Invalid JSON (${message.split("\n")[0]})` : message,
      path,
    };
  }
}

async function loadUserConfigMerged(): Promise<
  | { ok: false; error: string }
  | { ok: true; flat: CodeReviewMergedPartial; presets: Record<string, CodeReviewMergedPartial> }
> {
  const path = resolveUserCodeReviewConfigPath();
  const result = await loadConfigAt(path);
  if (!result.ok) {
    return { ok: false, error: `${result.path}: ${result.error}` };
  }
  return { ok: true, flat: result.flat, presets: result.presets };
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const t = value.trim().toLowerCase();
  if (t === "" || t === "0" || t === "false" || t === "no" || t === "off") {
    return false;
  }
  if (t === "1" || t === "true" || t === "yes" || t === "on") {
    return true;
  }
  return undefined;
}

/** Environment variables override merged file defaults (after preset); CLI overrides env. */
export function readEnvironmentCodeReviewConfig(): CodeReviewMergedPartial {
  const out: CodeReviewMergedPartial = {};
  for (const [suffix, field] of Object.entries(ENV_TO_FIELD)) {
    const full = `${ENV_PREFIX}${suffix}`;
    const raw = process.env[full];
    if (raw === undefined) {
      continue;
    }
    if ((BOOLEAN_FIELDS as readonly string[]).includes(field as string)) {
      const b = parseBoolEnv(raw);
      if (b !== undefined) {
        (out as Record<string, unknown>)[field as string] = b;
      }
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      (out as Record<string, unknown>)[field as string] = trimmed;
    }
  }
  return out;
}

function applyExplicitCliOptions(flat: CodeReviewMergedPartial, parsed: ParsedCodeReviewArgv): CliOptions {
  const ex = parsed.explicitKeys;
  const o = parsed.options;
  const stringOr = (k: keyof CliOptions): string | undefined => (ex.has(k) ? o[k] as string | undefined : flat[k] as string | undefined);
  const boolOr = (k: keyof CliOptions, def: boolean): boolean => (ex.has(k) ? (o[k] as boolean) : (flat[k] as boolean | undefined) ?? def);

  return {
    workspace: stringOr("workspace"),
    scratchpad: stringOr("scratchpad"),
    dryRun: boolOr("dryRun", false),
    contextBundle: stringOr("contextBundle"),
    result: stringOr("result"),
    consensus: stringOr("consensus"),
    adapter: stringOr("adapter"),
    model: stringOr("model"),
    variant: stringOr("variant"),
    agent: stringOr("agent"),
    opencode: stringOr("opencode"),
    claude: stringOr("claude"),
    claudeArgs: stringOr("claudeArgs"),
    cursor: stringOr("cursor"),
    cursorArgs: stringOr("cursorArgs"),
    cursorMode: stringOr("cursorMode"),
    log: stringOr("log"),
    pr: stringOr("pr"),
    postPr: stringOr("postPr"),
    reviewSummary: stringOr("reviewSummary"),
    postOnly: boolOr("postOnly", false),
    noConfirm: boolOr("noConfirm", false),
    replacePendingReview: boolOr("replacePendingReview", false),
    noDeterministic: boolOr("noDeterministic", false),
    strict: boolOr("strict", false),
    pendingReview: boolOr("pendingReview", false),
    pure: boolOr("pure", false),
    printLogs: boolOr("printLogs", false),
  };
}

export type ResolveCodeReviewCliResult =
  | { readonly ok: true; readonly options: CliOptions }
  | { readonly ok: false; readonly error: string };

/**
 * Merge order: user config < repo config < named `--preset` < environment < explicit CLI flags.
 * Repo config is read from `<workspace>/.review-agent/config.json` where workspace is
 * `resolve(parsed.options.workspace ?? cwd)` before merge (see README).
 */
export async function resolveCodeReviewCliOptions(
  workspacePath: string,
  parsed: ParsedCodeReviewArgv,
): Promise<ResolveCodeReviewCliResult> {
  const user = await loadUserConfigMerged();
  if (!user.ok) {
    return { ok: false, error: user.error };
  }

  const repoPath = resolveRepoCodeReviewConfigPath(workspacePath);
  const repo = await loadConfigAt(repoPath);
  if (!repo.ok) {
    return { ok: false, error: `${repo.path}: ${repo.error}` };
  }

  let merged = mergeFlatConfigLayers(mergeFlatConfigLayers({}, user.flat), repo.flat);
  const presets = mergePresetMaps(user.presets, repo.presets);

  if (parsed.presetName !== undefined) {
    const name = parsed.presetName.trim();
    if (name.length === 0) {
      return { ok: false, error: "Invalid --preset value (empty name)." };
    }
    const slice = presets[name];
    if (slice === undefined) {
      const known = Object.keys(presets);
      const hint =
        known.length === 0
          ? "No presets are defined in merged user/repo config files."
          : `Known presets: ${known.sort().join(", ")}`;
      return { ok: false, error: `Unknown preset '${name}'. ${hint}` };
    }
    merged = mergeFlatConfigLayers(merged, slice);
  }

  merged = mergeFlatConfigLayers(merged, readEnvironmentCodeReviewConfig());
  return { ok: true, options: applyExplicitCliOptions(merged, parsed) };
}
