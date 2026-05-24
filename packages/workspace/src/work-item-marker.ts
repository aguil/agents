import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const WORK_ITEM_MARKER_FILENAME = ".agents-work-item.json";

export interface WorkItemMarker {
  readonly identifier: string;
  readonly kind: string;
}

export async function writeWorkItemMarker(
  workspacePath: string,
  marker: WorkItemMarker,
): Promise<void> {
  await writeFile(
    join(workspacePath, WORK_ITEM_MARKER_FILENAME),
    `${JSON.stringify(marker)}\n`,
    "utf8",
  );
}

export async function listWorkItemMarkers(
  workspaceRoot: string,
): Promise<readonly WorkItemMarker[]> {
  const root = resolve(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const markers: WorkItemMarker[] = [];
  for (const entry of entries) {
    const path = resolve(root, entry);
    if (path !== root && !path.startsWith(`${root}/`)) {
      continue;
    }
    try {
      const raw = await readFile(join(path, WORK_ITEM_MARKER_FILENAME), "utf8");
      const parsed = JSON.parse(raw) as WorkItemMarker;
      if (
        typeof parsed.identifier === "string" &&
        typeof parsed.kind === "string"
      ) {
        markers.push(parsed);
      }
    } catch {
      // not a managed work-item workspace
    }
  }
  return markers;
}
