import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import harnessSchema from "./harness.schema.json" with { type: "json" };
import manifestSchema from "./manifest.schema.json" with { type: "json" };
import policySchema from "./policy.schema.json" with { type: "json" };

export type JsonSchema = Readonly<Record<string, unknown>>;

/**
 * The normative document schemas (ADR 0015 §2). Each is published verbatim
 * under `.agents/schemas/`; a test pins every pair of copies together.
 */
export const HARNESS_SCHEMA: JsonSchema = harnessSchema;
export const MANIFEST_SCHEMA: JsonSchema = manifestSchema;
export const POLICY_SCHEMA: JsonSchema = policySchema;

/**
 * What the document is called in an error message. Ajv reports the root as the
 * empty path, which needs a name, and nested paths read better prefixed by
 * nothing at all — `capabilities.exec`, not `policy.capabilities.exec`.
 */
const ROOT_LABELS: ReadonlyMap<JsonSchema, string> = new Map([
  [HARNESS_SCHEMA, "harness.yaml"],
  [MANIFEST_SCHEMA, "manifest.yaml"],
  [POLICY_SCHEMA, "the policy document"],
]);

function compile(schema: JsonSchema): ValidateFunction {
  // allErrors so a document with several mistakes reports all of them
  // rather than one per edit-and-retry cycle.
  // verbose so `parentSchema` is available — it carries the sibling
  // `properties`, which is how an unknown-key error can name the keys that
  // would have been accepted.
  return new Ajv({ allErrors: true, verbose: true, strict: false }).compile(
    schema,
  );
}

/**
 * Compiled validators, keyed by schema identity and bounded by construction:
 * only the three schemas this module owns are cached. `findAllSchemaViolations`
 * is public and takes a schema, so caching whatever it was handed would let a
 * caller passing freshly built objects grow this map without limit.
 */
const compiled = new Map<JsonSchema, ValidateFunction>();

function validatorFor(schema: JsonSchema): ValidateFunction {
  if (!ROOT_LABELS.has(schema)) {
    return compile(schema);
  }
  let validate = compiled.get(schema);
  if (validate === undefined) {
    validate = compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

/** `/roles/security/timeout_ms` reads better as `roles.security.timeout_ms`. */
function readablePath(instancePath: string, rootLabel: string): string {
  if (instancePath.length === 0) {
    return rootLabel;
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

function describe(error: ErrorObject, rootLabel: string): string {
  const where = readablePath(error.instancePath, rootLabel);
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
      return `${where} has invalid key "${String(error.params.propertyName)}"`;
    case "minProperties":
      return `${where} must not be empty`;
    default:
      return `${where} ${error.message ?? "is invalid"}`;
  }
}

/**
 * Keywords the loader's own checks do not cover.
 *
 * The schemas describe the whole format, because they are the normative
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
 * The policy document additionally reports type failures.
 *
 * Its failures are asymmetric in a way the other two documents' are not: it is
 * the enforcement source of truth for `packages/policy`, and the loader reads
 * its lists with helpers that treat an explicit null as an absent key. So
 * `deny:` with nothing after it produces a policy that grants everything —
 * fail-open, in the document whose only purpose is to constrain. No field here
 * is typed to accept null, so reporting type failures closes that whole class
 * at once. Range and enum failures stay with the loader, whose messages name
 * the offending value.
 */
const POLICY_ENFORCED_KEYWORDS: ReadonlySet<string> = new Set([
  ...ENFORCED_KEYWORDS,
  "type",
]);

function violations(
  document: unknown,
  schema: JsonSchema,
  keywords: ReadonlySet<string> | undefined,
): readonly string[] {
  const validate = validatorFor(schema);
  if (validate(document)) {
    return [];
  }
  const rootLabel = ROOT_LABELS.get(schema) ?? "the document";
  const problems = new Set<string>();
  for (const error of validate.errors ?? []) {
    if (keywords === undefined || keywords.has(error.keyword)) {
      problems.add(describe(error, rootLabel));
    }
  }
  return [...problems];
}

/**
 * Validate a parsed `harness.yaml` against the published schema, reporting the
 * unknown and misplaced keys the loader cannot detect. An empty array means
 * nothing of that kind was found; it does not mean the document is valid, and
 * the loader's semantic checks still run.
 */
export function validateHarnessDocument(document: unknown): readonly string[] {
  return violations(document, HARNESS_SCHEMA, ENFORCED_KEYWORDS);
}

/** As {@link validateHarnessDocument}, for a parsed `.agents/manifest.yaml`. */
export function validateManifestDocument(document: unknown): readonly string[] {
  return violations(document, MANIFEST_SCHEMA, ENFORCED_KEYWORDS);
}

/**
 * As {@link validateHarnessDocument}, for a parsed `.agents/policies/<id>.yaml`
 * — plus type failures, for the reason given on {@link POLICY_ENFORCED_KEYWORDS}.
 */
export function validatePolicyDocument(document: unknown): readonly string[] {
  return violations(document, POLICY_SCHEMA, POLICY_ENFORCED_KEYWORDS);
}

/**
 * Validate against every rule in a schema, including the ones the loader
 * reports itself. Not used at load time — the loader would report those with
 * better messages — but it is what a third party validating the published file
 * would apply, so it is how this repository checks that its schemas stay
 * truthful about documents that actually exist.
 */
export function findAllSchemaViolations(
  document: unknown,
  schema: JsonSchema = HARNESS_SCHEMA,
): readonly string[] {
  return violations(document, schema, undefined);
}
