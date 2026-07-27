/**
 * Every key the loader reads, grouped by the object level it appears on.
 *
 * This exists because two descriptions of the `.agents/` document formats now
 * live in this package — the published JSON Schemas and the loader's own
 * parsing — and nothing otherwise stops them diverging. A key added to the
 * schema alone is accepted and silently ignored, which is exactly the bug the
 * schemas were introduced to remove. `tests/harness-schema-drift.test.ts`
 * asserts each entry below against the corresponding schema location.
 *
 * Two kinds of entry, and the difference is worth knowing:
 *
 * - Most are **enforced**: the loader builds its unknown-key allowlist from
 *   the entry, so the list cannot disagree with the behavior it describes.
 * - The rest are **declared**: at those levels the schema is the only
 *   unknown-key gate, so the entry is an enumeration of what the parser
 *   reads. Getting one wrong is caught by the drift test rather than by the
 *   loader. Adding a key to the loader without adding it to the schema fails
 *   loudly at the first document that uses it, since the schema rejects it as
 *   unknown before the parser ever sees it; the quiet direction is the other
 *   one, and that is what the test covers.
 */
export const LOADER_ACCEPTED_KEYS = {
  /** declared — the schema is the only gate at the document root */
  harnessRoot: [
    "spec_version",
    "kind",
    "harness",
    "roles",
    "execution",
    "hooks",
    "context",
    "output",
    "filtering",
    "deduplication",
    "reporting",
    "policy",
    "default_allowed_commands",
  ],
  /** declared */
  harnessIdentity: ["id", "description"],
  /** enforced — `ROLE_FIELDS` plus the reference key, which is stripped early */
  role: [
    "ref",
    "description",
    "enabled",
    "prompt",
    "prompt_path",
    "timeout_ms",
    "allowed_commands",
    "required_capabilities",
    "policy",
  ],
  /** declared */
  execution: [
    "mode",
    "order",
    "pass_check",
    "implementation_roles",
    "validation_roles",
    "max_rounds",
  ],
  /** enforced */
  hookHandler: ["command", "matcher", "timeout_s", "applies_to"],
  /** enforced */
  context: ["providers"],
  /** enforced */
  output: ["schemas"],
  /** enforced */
  outputSchema: ["required", "data_required"],
  /** enforced — shared by `filtering` and `deduplication` */
  findingStrategies: ["findings"],
  /** enforced */
  reporting: ["template"],
  /** declared */
  manifestRoot: ["specVersion", "enabled"],
  /** declared */
  manifestEnabled: ["harnesses"],
  /** declared */
  policyRoot: ["id", "description", "capabilities", "limits", "confirmations"],
  /** declared */
  policyCapabilities: ["filesystem", "exec", "network"],
  /** declared */
  policyCapabilityRules: ["allow", "deny"],
  /** declared */
  policyLimits: ["cost_usd", "timeout_ms"],
  /** declared — both spellings are accepted, `requiredFor` winning */
  policyConfirmations: ["requiredFor", "required_for"],
} as const satisfies Record<string, readonly string[]>;

export type LoaderKeyLevel = keyof typeof LOADER_ACCEPTED_KEYS;

/**
 * Role-file frontmatter has no published schema — a role file is Markdown,
 * not one of the three YAML documents — so it is derived here rather than
 * listed above. `prompt` and `prompt_path` are excluded deliberately: the
 * Markdown body is the prompt, so a role file has no need to point elsewhere.
 */
export const ROLE_FILE_ACCEPTED_KEYS: readonly string[] =
  LOADER_ACCEPTED_KEYS.role.filter(
    (field) => field !== "ref" && field !== "prompt" && field !== "prompt_path",
  );
