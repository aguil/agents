/** Minimal YAML parser for WORKFLOW.md front matter (maps, lists, scalars). */

const LIST_PARENT_KEYS = new Set(["feeds", "active_states", "terminal_states"]);

type StackFrame =
  | {
      readonly kind: "map";
      readonly indent: number;
      readonly value: Record<string, unknown>;
    }
  | {
      readonly kind: "list";
      readonly indent: number;
      readonly value: unknown[];
    };

export function parseYamlFrontMatter(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: StackFrame[] = [{ kind: "map", indent: -1, value: root }];

  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim().length === 0 || line.trim().startsWith("#")) {
      continue;
    }
    const indent = line.search(/\S/);
    let trimmed = line.trim();
    const isListItem = trimmed.startsWith("- ");
    if (isListItem) {
      trimmed = trimmed.slice(2).trim();
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    if (isListItem) {
      const top = stack[stack.length - 1];
      if (top.kind !== "list") {
        throw new Error(
          `workflow_parse_error: list item without parent list at "${line}"`,
        );
      }
      const colon = trimmed.indexOf(":");
      if (colon <= 0) {
        top.value.push(parseScalar(trimmed));
        continue;
      }
      const key = trimmed.slice(0, colon).trim();
      const rest = trimmed.slice(colon + 1).trim();
      if (rest.length === 0) {
        const item: Record<string, unknown> = {};
        top.value.push(item);
        stack.push({ kind: "map", indent, value: item });
        continue;
      }
      const item: Record<string, unknown> = { [key]: parseScalar(rest) };
      top.value.push(item);
      stack.push({ kind: "map", indent, value: item });
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      throw new Error(`workflow_parse_error: invalid line "${line}"`);
    }
    const key = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();

    const top = stack[stack.length - 1];
    if (top.kind !== "map") {
      throw new Error(`workflow_parse_error: key outside map at "${line}"`);
    }
    const parent = top.value;

    if (rest.length === 0) {
      if (LIST_PARENT_KEYS.has(key)) {
        const list: unknown[] = [];
        parent[key] = list;
        stack.push({ kind: "list", indent, value: list });
        continue;
      }
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ kind: "map", indent, value: child });
      continue;
    }

    if (rest.startsWith("[") && rest.endsWith("]")) {
      parent[key] = parseInlineList(rest);
      continue;
    }

    parent[key] = parseScalar(rest);
  }

  return root;
}

function parseInlineList(raw: string): unknown[] {
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) {
    return [];
  }
  return inner.split(",").map((part) => parseScalar(part.trim()));
}

function parseScalar(raw: string): string | number | boolean {
  let value = raw;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return value;
}
