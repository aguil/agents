import { codeReviewHarnessPackageCliDefaults } from "@aguil/agents-code-review";
import { readFile } from "node:fs/promises";
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

/** camelCase CLI option keys accepted at the root of JSON or inside a preset body. */
const ALLOWED_JSON_FLAT_KEYS: ReadonlySet<string> = new Set([...STRING_FIELDS, ...BOOLEAN_FIELDS]);

/** In JSON configs, comma-separated subprocess arg templates may be arrays of strings instead. */
const ARGS_TEMPLATE_FIELDS = ["claudeArgs", "cursorArgs"] as const satisfies readonly (keyof CliOptions & string)[];

function isStrictUnknownConfigEnv(): boolean {
  return parseBoolEnv(process.env.AGENTS_CODE_REVIEW_CONFIG_STRICT) === true;
}

/** Validate and normalize `cursorArgs` / `claudeArgs` from JSON (trimmed string, or string array kept verbatim). */
export function normalizeAdapterArgsTemplateField(
  fieldKey: keyof CliOptions,
  value: unknown,
):
  | { readonly ok: true; readonly normalized?: string | readonly string[] }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  if (typeof value === "string") {
    const t = value.trim();
    return t.length === 0 ? { ok: true } : { ok: true, normalized: t };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: `'${fieldKey}' must be a string or an array of non-empty strings`,
    };
  }
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return {
        ok: false,
        error: `'${fieldKey}' array entries must all be strings`,
      };
    }
    const trimmed = item.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  if (parts.length === 0) {
    return { ok: true };
  }
  return { ok: true, normalized: parts };
}

function unknownFlatKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => !ALLOWED_JSON_FLAT_KEYS.has(key)).sort();
}

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

/** Host-binary paths plus argv templates must not originate from `.review-agent` JSON alone. */
const REPO_BLOCKED_ADAPTER_LAUNCH_KEYS = [
  "claude",
  "claudeArgs",
  "cursor",
  "cursorArgs",
  "opencode",
] as const satisfies readonly (keyof CliOptions)[];

/** Strip launcher-related overrides from workspace repo-config partials before merge. */
export function sanitizeRepoAdapterExecutablePartial(
  partial: CodeReviewMergedPartial,
): { readonly sanitized: CodeReviewMergedPartial; readonly strippedKeys: readonly string[] } {
  const stripped: string[] = [];
  const sanitized: CodeReviewMergedPartial = { ...partial };
  const rec = sanitized as Record<string, unknown>;
  for (const key of REPO_BLOCKED_ADAPTER_LAUNCH_KEYS) {
    if (rec[key] !== undefined) {
      stripped.push(key);
      delete rec[key];
    }
  }
  return { sanitized, strippedKeys: stripped };
}

function sanitizeRepoConfigDocument(
  flat: CodeReviewMergedPartial,
  presets: Record<string, CodeReviewMergedPartial>,
  loadedFromPath?: string,
): { readonly flat: CodeReviewMergedPartial; readonly presets: Record<string, CodeReviewMergedPartial> } {
  const removed = new Set<string>();
  const top = sanitizeRepoAdapterExecutablePartial(flat);
  const nextFlat = top.sanitized;
  for (const k of top.strippedKeys) {
    removed.add(k);
  }

  const nextPresets: Record<string, CodeReviewMergedPartial> = { ...presets };
  for (const name of Object.keys(nextPresets)) {
    const body = nextPresets[name]!;
    const inner = sanitizeRepoAdapterExecutablePartial(body);
    nextPresets[name] = inner.sanitized;
    for (const k of inner.strippedKeys) {
      removed.add(`preset:${name}.${k}`);
    }
  }

  if (removed.size > 0 && loadedFromPath !== undefined) {
    console.warn(
      `${loadedFromPath}: ignoring repo-managed adapter launch overrides (${[...removed].sort().join(
        ", ",
      )}). Executable paths (\`cursor\`, \`claude\`, \`opencode\`) and argv templates (\`cursorArgs\`, \`claudeArgs\`) must come only from user ~/.config/agents/code-review/config.json, AGENTS_CODE_REVIEW_*, or CLI flags.`,
    );
  }

  return { flat: nextFlat, presets: nextPresets };
}

const ARGS_MERGE_FIELDS: ReadonlySet<keyof CliOptions> = new Set(["claudeArgs", "cursorArgs"]);

export function mergeFlatConfigLayers(base: CodeReviewMergedPartial, overlay: CodeReviewMergedPartial): CodeReviewMergedPartial {
  const next: CodeReviewMergedPartial = { ...base };
  for (const key of STRING_FIELDS) {
    const v = overlay[key];
    if (typeof v === "string") {
      (next as Record<string, unknown>)[key as string] = v;
    } else if (ARGS_MERGE_FIELDS.has(key) && Array.isArray(v) && v.every((part) => typeof part === "string")) {
      (next as Record<string, unknown>)[key as string] = v as readonly string[];
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

function extractFlatFields(
  raw: Record<string, unknown>,
  diagnosticsPrefix: string,
  strictUnknownKeys: boolean,
):
  | { ok: false; error: string }
  | {
      readonly ok: true;
      readonly flat: CodeReviewMergedPartial;
      readonly unknownKeysDiagnostic?: string;
    } {
  const unknown = unknownFlatKeys(raw);
  if (unknown.length > 0) {
    const detail = `${diagnosticsPrefix}: unknown keys: ${unknown.join(", ")}`;
    if (strictUnknownKeys) {
      return {
        ok: false,
        error: detail,
      };
    }
  }

  const out: CodeReviewMergedPartial = {};
  const plainStringFields = STRING_FIELDS.filter(
    (f) => !(ARGS_TEMPLATE_FIELDS as readonly string[]).includes(f),
  );

  for (const field of plainStringFields) {
    if (field in raw) {
      const s = parseStringJson(raw[field]);
      if (s !== undefined && s.length > 0) {
        (out as Record<string, unknown>)[field] = s;
      }
    }
  }
  for (const field of ARGS_TEMPLATE_FIELDS) {
    if (!(field in raw)) {
      continue;
    }
    const norm = normalizeAdapterArgsTemplateField(field, raw[field]);
    if (!norm.ok) {
      return { ok: false, error: `${diagnosticsPrefix}: ${norm.error}` };
    }
    if (norm.normalized !== undefined) {
      (out as Record<string, unknown>)[field] = norm.normalized;
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
  return unknown.length === 0
    ? { ok: true, flat: out }
    : {
        ok: true,
        flat: out,
        unknownKeysDiagnostic: `${diagnosticsPrefix}: unknown keys ignored: ${unknown.join(", ")}`,
      };
}

export function extractConfigDocument(raw: unknown):
  | { ok: false; error: string }
  | {
      ok: true;
      readonly flat: CodeReviewMergedPartial;
      readonly presets: Record<string, CodeReviewMergedPartial>;
      readonly diagnostics: readonly string[];
    } {
  const strictUnknown = isStrictUnknownConfigEnv();
  const diagnostics: string[] = [];

  if (raw === undefined) {
    return { ok: true, flat: {}, presets: {}, diagnostics: [] };
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

  const flatExtracted = extractFlatFields(flatSource, "config (top-level)", strictUnknown);
  if (!flatExtracted.ok) {
    return flatExtracted;
  }
  if (flatExtracted.unknownKeysDiagnostic !== undefined) {
    diagnostics.push(flatExtracted.unknownKeysDiagnostic);
  }
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
    const bodyFlat = extractFlatFields(body as Record<string, unknown>, `preset '${name}'`, strictUnknown);
    if (!bodyFlat.ok) {
      return bodyFlat;
    }
    if (bodyFlat.unknownKeysDiagnostic !== undefined) {
      diagnostics.push(bodyFlat.unknownKeysDiagnostic);
    }
    presets[name] = bodyFlat.flat;
  }
  return { ok: true, flat: flatExtracted.flat, presets, diagnostics };
}

async function loadConfigAt(path: string): Promise<
  | { ok: false; error: string; path: string }
  | { ok: true; flat: CodeReviewMergedPartial; presets: Record<string, CodeReviewMergedPartial>; path?: string }
> {
  let rawUtf8: string;
  try {
    rawUtf8 = await readFile(path, "utf8");
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
    const raw = JSON.parse(rawUtf8) as unknown;
    const parsed = extractConfigDocument(raw);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, path };
    }
    for (const diag of parsed.diagnostics) {
      console.warn(`${path}: ${diag}`);
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
  const adapterArgsTemplateOr = (
    k: "claudeArgs" | "cursorArgs",
  ): string | readonly string[] | undefined => {
    if (ex.has(k)) {
      const fromCli = o[k];
      return typeof fromCli === "string" ? fromCli : undefined;
    }
    return flat[k] as string | readonly string[] | undefined;
  };
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
    claudeArgs: adapterArgsTemplateOr("claudeArgs"),
    cursor: stringOr("cursor"),
    cursorArgs: adapterArgsTemplateOr("cursorArgs"),
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
 * Merge order: harness package defaults < user config < repo config < named `--preset`
 * < environment < explicit CLI flags.
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

  const repoSanitized = sanitizeRepoConfigDocument(repo.flat, repo.presets, repo.path);

  let merged = mergeFlatConfigLayers(
    mergeFlatConfigLayers({ ...codeReviewHarnessPackageCliDefaults } as CodeReviewMergedPartial, user.flat),
    repoSanitized.flat,
  );

  if (parsed.presetName !== undefined) {
    const presets = mergePresetMaps(user.presets, repoSanitized.presets);
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
