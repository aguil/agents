import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import harnessSchema from "./harness.schema.json" with { type: "json" };

/**
 * The normative harness document schema (ADR 0015 §2). Published verbatim at
 * `.agents/schemas/harness.schema.json`; a test pins the two copies together.
 */
export const HARNESS_SCHEMA: Readonly<Record<string, unknown>> = harnessSchema;

let compiled: ValidateFunction | undefined;

function harnessValidator(): ValidateFunction {
  if (compiled === undefined) {
    // allErrors so a document with several mistakes reports all of them
    // rather than one per edit-and-retry cycle.
    // allErrors so a document with several mistakes reports all of them.
    // verbose so `parentSchema` is available — it carries the sibling
    // `properties`, which is how an unknown-key error can name the keys that
    // would have been accepted.
    compiled = new Ajv({
      allErrors: true,
      verbose: true,
      strict: false,
    }).compile(harnessSchema);
  }
  return compiled;
}

/** `/roles/security/timeout_ms` reads better as `roles.security.timeout_ms`. */
function readablePath(instancePath: string): string {
  if (instancePath.length === 0) {
    return "harness.yaml";
  }
  return instancePath.slice(1).split("/").join(".");
}

/**
 * Ajv omits the offending key from `message` and puts it in `params`, so the
 * default text ("must NOT have additional properties") does not say which key
 * is wrong — the one thing a reader needs when the cause is a typo.
 */
/** The keys the failing object would have accepted, for the error message. */
function allowedKeys(error: ErrorObject): readonly string[] {
  const parent = error.parentSchema as
    | { properties?: Record<string, unknown> }
    | undefined;
  return Object.keys(parent?.properties ?? {}).sort();
}

function describe(error: ErrorObject): string {
  const where = readablePath(error.instancePath);
  switch (error.keyword) {
    case "additionalProperties": {
      const key = String(error.params.additionalProperty);
      const allowed = allowedKeys(error);
      const suffix =
        allowed.length === 0 ? "" : ` (supported: ${allowed.join(", ")})`;
      return `${where} has unknown key "${key}"${suffix}`;
    }
    case "required":
      return `${where} is missing required key "${String(error.params.missingProperty)}"`;
    case "enum": {
      const allowed = (error.params.allowedValues as unknown[]).join(", ");
      return `${where} must be one of: ${allowed}`;
    }
    case "const":
      return `${where} must be ${JSON.stringify(error.params.allowedValue)}`;
    case "propertyNames":
      return `${where} has an invalid key`;
    case "minProperties":
      return `${where} must not be empty`;
    default:
      return `${where} ${error.message ?? "is invalid"}`;
  }
}

/**
 * Keywords the loader's own checks do not cover.
 *
 * The schema describes the whole format, because it is the normative
 * description (ADR 0015 §2) and third parties validate against all of it. The
 * loader, though, already checks every *known* key with messages that name the
 * offending value — "reporting.template has unknown template X (supported: …)"
 * beats "must be one of: …". What it has never done is reject keys it does not
 * know, which is why a misspelling silently does nothing.
 *
 * So the runtime gate reports only the classes the loader misses and leaves the
 * rest to it. Net enforcement is the same; the message a reader gets is the
 * better of the two.
 */
const ENFORCED_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalProperties",
  "propertyNames",
]);

/**
 * Validate a parsed `harness.yaml` against the published schema, reporting the
 * unknown and misplaced keys the loader cannot detect. An empty array means
 * nothing of that kind was found; it does not mean the document is valid, and
 * the loader's semantic checks still run.
 */
export function validateHarnessDocument(document: unknown): readonly string[] {
  const validate = harnessValidator();
  if (validate(document)) {
    return [];
  }
  const problems = new Set<string>();
  for (const error of validate.errors ?? []) {
    if (ENFORCED_KEYWORDS.has(error.keyword)) {
      problems.add(describe(error));
    }
  }
  return [...problems];
}
