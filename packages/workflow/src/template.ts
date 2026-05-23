/** Strict Liquid-like {{ path }} interpolation for workflow prompts. */

export type TemplateRenderError =
  | { readonly code: "template_parse_error"; readonly message: string }
  | { readonly code: "template_render_error"; readonly message: string };

const TAG_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;

export type TemplateRenderResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: TemplateRenderError };

export function renderStrictTemplate(
  template: string,
  variables: Readonly<Record<string, unknown>>,
): TemplateRenderResult {
  try {
    const output = template.replace(TAG_RE, (_match, path: string) => {
      const value = lookupPath(variables, path.split("."));
      if (value === undefined) {
        throw new Error(`unknown variable "${path}"`);
      }
      if (value === null) {
        return "";
      }
      if (typeof value === "object") {
        throw new Error(`cannot render object at "${path}"`);
      }
      return String(value);
    });
    return { ok: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("unknown variable")) {
      return {
        ok: false,
        error: { code: "template_render_error", message },
      };
    }
    return { ok: false, error: { code: "template_parse_error", message } };
  }
}

function lookupPath(
  root: Readonly<Record<string, unknown>>,
  segments: readonly string[],
): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (
      typeof current !== "object" ||
      current === null ||
      !(segment in (current as Record<string, unknown>))
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
