/**
 * Parse `--models` / config `models` (`role=model,role2=model2`) into a
 * per-role map for the adapter. Role ids are harness role ids; unmapped
 * roles fall back to the global `--model`.
 */
export function parseRoleModels(
  value: string | undefined,
):
  | { readonly ok: true; readonly models?: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly error: string } {
  if (value === undefined) {
    return { ok: true };
  }
  const models: Record<string, string> = {};
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return { ok: true };
  }
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    const role = eq >= 0 ? entry.slice(0, eq).trim() : "";
    const model = eq >= 0 ? entry.slice(eq + 1).trim() : "";
    if (eq < 0 || role.length === 0 || model.length === 0) {
      return {
        ok: false,
        error: `Invalid models entry '${entry}'. Expected role=model pairs, e.g. security=provider/strong,quality=provider/fast.`,
      };
    }
    if (models[role] !== undefined && models[role] !== model) {
      return {
        ok: false,
        error: `Conflicting models entries for role '${role}' ('${models[role]}' vs '${model}').`,
      };
    }
    models[role] = model;
  }
  return { ok: true, models };
}
