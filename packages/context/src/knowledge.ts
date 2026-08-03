import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readBoundedFile, resolveWorkspacePath } from "./fs-bounds";
import type {
  ContextArtifact,
  ContextProvider,
  ContextRequest,
} from "./provider-types";

/** Default store root relative to the workspace (ADR 0022 §2). */
export const DEFAULT_KNOWLEDGE_PATH = ".agents/knowledge";

/** Injection note-count default (ADR 0022 §6). */
export const DEFAULT_KNOWLEDGE_MAX_NOTES = 10;

/** Aggregate byte default for both providers (ADR 0022 §6 / §9). */
export const DEFAULT_KNOWLEDGE_MAX_BYTES = 50_000;

/** Search result count default (ADR 0022 §9). */
export const DEFAULT_KNOWLEDGE_SEARCH_LIMIT = 5;

/** Reserved machine-authored id prefix (ADR 0022 §9 / §10). */
export const DEFAULT_MACHINE_ID_PREFIX = "harness:";

/**
 * Cap on Markdown paths visited per store load. Matches file-glob's default
 * scan bound so a hostile or accidental tree cannot force unbounded walks.
 */
export const DEFAULT_KNOWLEDGE_MAX_SCANNED = 10_000;

/**
 * Per-file read cap when loading notes. Frontmatter sits at the top of the
 * file; bodies beyond this bound are truncated before admission.
 */
export const DEFAULT_KNOWLEDGE_READ_BYTES = DEFAULT_KNOWLEDGE_MAX_BYTES;

export type KnowledgeContextMode = "auto" | "search-only";

export type KnowledgeProvenanceFilter = "any" | "machine" | "human";

export type KnowledgeSkipReason =
  | "unreadable"
  | "no-frontmatter"
  | "unterminated-frontmatter"
  | "invalid-yaml"
  | "missing-id"
  | "invalid-field"
  | "duplicate-id"
  | "outside-workspace"
  | "scan-truncated";

export interface KnowledgeNote {
  readonly id: string;
  readonly title: string;
  readonly context: KnowledgeContextMode;
  readonly tags: readonly string[];
  readonly updatedAt?: string;
  readonly body: string;
  readonly sourcePath: string;
}

export interface KnowledgeSkip {
  readonly path: string;
  readonly reason: KnowledgeSkipReason;
  readonly detail?: string;
}

export interface KnowledgeStoreLoad {
  readonly notes: readonly KnowledgeNote[];
  readonly skipped: readonly KnowledgeSkip[];
}

export type KnowledgeBoundHit = "max_notes" | "max_bytes" | "limit";

export interface KnowledgeAdmission {
  readonly admitted: readonly string[];
  readonly omitted: readonly string[];
  readonly bound?: KnowledgeBoundHit;
}

/**
 * Split Markdown YAML frontmatter the same way `parseRoleFile` does
 * (Bun.YAML.parse + `---` delimiters), but return a structured failure
 * instead of throwing — notes are data, not configuration (ADR 0022 §4).
 */
export function parseKnowledgeNoteSource(
  source: string,
  sourcePath: string,
):
  | { readonly ok: true; readonly note: KnowledgeNote }
  | { readonly ok: false; readonly skip: KnowledgeSkip } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") {
    return {
      ok: false,
      skip: { path: sourcePath, reason: "no-frontmatter" },
    };
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    return {
      ok: false,
      skip: { path: sourcePath, reason: "unterminated-frontmatter" },
    };
  }
  const frontMatterSource = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(frontMatterSource);
  } catch (error) {
    return {
      ok: false,
      skip: {
        path: sourcePath,
        reason: "invalid-yaml",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      skip: {
        path: sourcePath,
        reason: "invalid-yaml",
        detail: "frontmatter must be a mapping",
      },
    };
  }
  const front = parsed as Record<string, unknown>;

  const idValue = front.id;
  if (typeof idValue !== "string" || idValue.trim().length === 0) {
    return {
      ok: false,
      skip: { path: sourcePath, reason: "missing-id" },
    };
  }
  const id = idValue.trim();

  let context: KnowledgeContextMode = "search-only";
  if (front.context !== undefined) {
    if (front.context !== "auto" && front.context !== "search-only") {
      return {
        ok: false,
        skip: {
          path: sourcePath,
          reason: "invalid-field",
          detail: `context must be "auto" or "search-only", got ${JSON.stringify(front.context)}`,
        },
      };
    }
    context = front.context;
  }

  let tags: readonly string[] = [];
  if (front.tags !== undefined) {
    if (
      !Array.isArray(front.tags) ||
      front.tags.some((tag) => typeof tag !== "string")
    ) {
      return {
        ok: false,
        skip: {
          path: sourcePath,
          reason: "invalid-field",
          detail: "tags must be a list of strings",
        },
      };
    }
    tags = front.tags as readonly string[];
  }

  let title = id;
  if (front.title !== undefined) {
    if (typeof front.title !== "string" || front.title.length === 0) {
      return {
        ok: false,
        skip: {
          path: sourcePath,
          reason: "invalid-field",
          detail: "title must be a non-empty string when present",
        },
      };
    }
    title = front.title;
  }

  let updatedAt: string | undefined;
  if (front.updatedAt !== undefined) {
    if (typeof front.updatedAt !== "string" || front.updatedAt.length === 0) {
      return {
        ok: false,
        skip: {
          path: sourcePath,
          reason: "invalid-field",
          detail: "updatedAt must be a non-empty string when present",
        },
      };
    }
    updatedAt = front.updatedAt;
  }

  return {
    ok: true,
    note: {
      id,
      title,
      context,
      tags,
      ...(updatedAt === undefined ? {} : { updatedAt }),
      body,
      sourcePath,
    },
  };
}

/** Recency descending, then id ascending; notes without updatedAt sort last. */
export function compareKnowledgeNotesForAdmission(
  a: KnowledgeNote,
  b: KnowledgeNote,
): number {
  const aHas = a.updatedAt !== undefined;
  const bHas = b.updatedAt !== undefined;
  if (aHas && !bHas) {
    return -1;
  }
  if (!aHas && bHas) {
    return 1;
  }
  if (aHas && bHas) {
    const aUpdated = a.updatedAt ?? "";
    const bUpdated = b.updatedAt ?? "";
    // updatedAt descending
    if (aUpdated > bUpdated) {
      return -1;
    }
    if (aUpdated < bUpdated) {
      return 1;
    }
  }
  if (a.id < b.id) {
    return -1;
  }
  if (a.id > b.id) {
    return 1;
  }
  return 0;
}

export function noteIsMachineAuthored(
  note: KnowledgeNote,
  machineIdPrefix: string,
): boolean {
  return note.id.startsWith(machineIdPrefix);
}

export function noteMatchesTags(
  note: KnowledgeNote,
  tags: readonly string[],
): boolean {
  if (tags.length === 0) {
    return true;
  }
  const noteTags = new Set(note.tags.map((tag) => tag.toLowerCase()));
  return tags.every((tag) => noteTags.has(tag.toLowerCase()));
}

export function noteMatchesProvenance(
  note: KnowledgeNote,
  provenance: KnowledgeProvenanceFilter,
  machineIdPrefix: string,
): boolean {
  if (provenance === "any") {
    return true;
  }
  const machine = noteIsMachineAuthored(note, machineIdPrefix);
  return provenance === "machine" ? machine : !machine;
}

/**
 * List Markdown paths under a store root, including symlinks. Bun.Glob can
 * omit symlink entries; a hostile link must still be considered so the
 * workspace containment check can reject it (ADR 0022 §2).
 */
async function listKnowledgeMarkdownFiles(
  root: string,
  maxScanned: number,
): Promise<{ readonly files: readonly string[]; readonly truncated: boolean }> {
  const found: string[] = [];
  let truncated = false;
  async function walk(relativeDir: string): Promise<void> {
    if (truncated || found.length >= maxScanned) {
      truncated = found.length >= maxScanned || truncated;
      return;
    }
    let entries: Dirent<string>[];
    try {
      entries = await readdir(join(root, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= maxScanned) {
        truncated = true;
        return;
      }
      const relative = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(relative);
        continue;
      }
      if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.endsWith(".md")
      ) {
        found.push(relative);
      }
    }
  }
  await walk("");
  return { files: found, truncated };
}

export interface LoadKnowledgeStoreOptions {
  readonly maxScanned?: number;
  readonly maxReadBytes?: number;
}

/**
 * Scan `.agents/knowledge` (or `path`) for Markdown notes. Missing/empty
 * stores yield an empty load, not an error. Malformed notes are skipped and
 * reported (ADR 0022 §2 / §4).
 */
export async function loadKnowledgeStore(
  workspacePath: string,
  storePath: string = DEFAULT_KNOWLEDGE_PATH,
  options: LoadKnowledgeStoreOptions = {},
): Promise<KnowledgeStoreLoad> {
  const maxScanned = options.maxScanned ?? DEFAULT_KNOWLEDGE_MAX_SCANNED;
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_KNOWLEDGE_READ_BYTES;
  const root = await resolveWorkspacePath(workspacePath, storePath, false);
  if (root === undefined) {
    return {
      notes: [],
      skipped: [
        {
          path: storePath,
          reason: "outside-workspace",
          detail: "knowledge store path escapes the workspace",
        },
      ],
    };
  }

  let relativeMatches: readonly string[] = [];
  let scanTruncated = false;
  try {
    const listed = await listKnowledgeMarkdownFiles(root, maxScanned);
    relativeMatches = listed.files;
    scanTruncated = listed.truncated;
  } catch {
    // Absent or unreadable root → empty store, not an error.
    return { notes: [], skipped: [] };
  }

  const notes: KnowledgeNote[] = [];
  const skipped: KnowledgeSkip[] = [];
  const seenIds = new Map<string, string>();

  if (scanTruncated) {
    skipped.push({
      path: storePath,
      reason: "scan-truncated",
      detail: `store scan stopped after ${maxScanned} Markdown paths`,
    });
  }

  for (const relative of relativeMatches) {
    const candidate = join(storePath, relative);
    const absolute = await resolveWorkspacePath(
      workspacePath,
      candidate,
      false,
    );
    if (absolute === undefined) {
      skipped.push({
        path: candidate,
        reason: "outside-workspace",
      });
      continue;
    }
    let source: string;
    try {
      source = await readBoundedFile(absolute, maxReadBytes);
    } catch {
      skipped.push({ path: candidate, reason: "unreadable" });
      continue;
    }
    const parsed = parseKnowledgeNoteSource(source, candidate);
    if (!parsed.ok) {
      skipped.push(parsed.skip);
      continue;
    }
    const prior = seenIds.get(parsed.note.id);
    if (prior !== undefined) {
      skipped.push({
        path: candidate,
        reason: "duplicate-id",
        detail: `id "${parsed.note.id}" already seen at ${prior}`,
      });
      continue;
    }
    seenIds.set(parsed.note.id, candidate);
    notes.push(parsed.note);
  }

  return { notes, skipped };
}

/**
 * Truncate so the UTF-8 byte length of the result is ≤ maxBytes, including the
 * truncation marker when one is needed. The shared truncateArtifactContent
 * helper can overshoot by the marker length; aggregate admission cannot.
 */
function truncateWithinBudget(
  content: string,
  maxBytes: number,
): string | undefined {
  if (maxBytes <= 0) {
    return undefined;
  }
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  const markerFor = (n: number): string => `\n[truncated at ${n} bytes]`;
  // Worst-case marker length for this budget (digits grow slowly with n).
  let cut = maxBytes;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const marker = markerFor(cut);
    const markerBytes = Buffer.byteLength(marker, "utf8");
    const headBudget = Math.max(0, maxBytes - markerBytes);
    const head = Buffer.from(content, "utf8")
      .subarray(0, headBudget)
      .toString("utf8");
    const actualCut = Buffer.byteLength(head, "utf8");
    const result = `${head}${markerFor(actualCut)}`;
    if (Buffer.byteLength(result, "utf8") <= maxBytes) {
      return result;
    }
    cut = actualCut > 0 ? actualCut - 1 : 0;
  }
  return undefined;
}

function admitNotesByBudget(
  eligible: readonly KnowledgeNote[],
  options: {
    readonly maxNotes?: number;
    readonly maxBytes: number;
    readonly limit?: number;
  },
): {
  readonly admitted: readonly KnowledgeNote[];
  readonly omitted: readonly KnowledgeNote[];
  readonly bound?: KnowledgeBoundHit;
  readonly contents: ReadonlyMap<string, string>;
} {
  const sorted = [...eligible].sort(compareKnowledgeNotesForAdmission);
  const admitted: KnowledgeNote[] = [];
  const omitted: KnowledgeNote[] = [];
  const contents = new Map<string, string>();
  let remainingBytes = options.maxBytes;
  let bound: KnowledgeBoundHit | undefined;
  const noteCap = options.limit ?? options.maxNotes;

  for (const note of sorted) {
    if (noteCap !== undefined && admitted.length >= noteCap) {
      omitted.push(note);
      bound ??= options.limit !== undefined ? "limit" : "max_notes";
      continue;
    }
    const content = truncateWithinBudget(note.body, remainingBytes);
    if (content === undefined) {
      omitted.push(note);
      bound ??= "max_bytes";
      continue;
    }
    const size = Buffer.byteLength(content, "utf8");
    admitted.push(note);
    contents.set(note.id, content);
    remainingBytes -= size;
  }

  return { admitted, omitted, bound, contents };
}

function metaArtifacts(
  idPrefix: string,
  skipped: readonly KnowledgeSkip[],
  admission: KnowledgeAdmission | undefined,
): ContextArtifact[] {
  const artifacts: ContextArtifact[] = [];
  if (skipped.length > 0) {
    artifacts.push({
      id: `${idPrefix}:skipped`,
      title: "Knowledge notes skipped",
      content: JSON.stringify({ skipped }, null, 2),
    });
  }
  if (
    admission !== undefined &&
    (admission.omitted.length > 0 || admission.bound !== undefined)
  ) {
    artifacts.push({
      id: `${idPrefix}:admission`,
      title: "Knowledge admission",
      content: JSON.stringify(admission, null, 2),
    });
  }
  return artifacts;
}

function noteArtifacts(
  idPrefix: string,
  notes: readonly KnowledgeNote[],
  contents: ReadonlyMap<string, string>,
): ContextArtifact[] {
  return notes.map((note) => ({
    id: `${idPrefix}:${note.id}`,
    title: note.title,
    path: note.sourcePath,
    content: contents.get(note.id) ?? note.body,
  }));
}

export interface KnowledgeProviderOptions {
  readonly path?: string;
  readonly maxNotes?: number;
  readonly maxBytes?: number;
}

/** Auto-injection provider: admits only `context: auto` notes (ADR 0022 §5). */
export class KnowledgeProvider implements ContextProvider {
  readonly name = "knowledge";

  constructor(private readonly options: KnowledgeProviderOptions = {}) {}

  async collect(request: ContextRequest): Promise<readonly ContextArtifact[]> {
    const storePath = this.options.path ?? DEFAULT_KNOWLEDGE_PATH;
    const maxNotes = this.options.maxNotes ?? DEFAULT_KNOWLEDGE_MAX_NOTES;
    const maxBytes = this.options.maxBytes ?? DEFAULT_KNOWLEDGE_MAX_BYTES;
    const loaded = await loadKnowledgeStore(request.workspacePath, storePath);
    const eligible = loaded.notes.filter((note) => note.context === "auto");
    const result = admitNotesByBudget(eligible, { maxNotes, maxBytes });
    const admission: KnowledgeAdmission = {
      admitted: result.admitted.map((note) => note.id),
      omitted: result.omitted.map((note) => note.id),
      ...(result.bound === undefined ? {} : { bound: result.bound }),
    };
    return [
      ...noteArtifacts("knowledge", result.admitted, result.contents),
      ...metaArtifacts("knowledge", loaded.skipped, admission),
    ];
  }
}

export interface KnowledgeSearchProviderOptions {
  readonly tags: readonly string[];
  readonly limit?: number;
  readonly provenance?: KnowledgeProvenanceFilter;
  readonly machineIdPrefix?: string;
  readonly path?: string;
  readonly maxBytes?: number;
}

/** Tag search provider (ADR 0022 §9). */
export class KnowledgeSearchProvider implements ContextProvider {
  readonly name = "knowledge-search";

  constructor(private readonly options: KnowledgeSearchProviderOptions) {}

  async collect(request: ContextRequest): Promise<readonly ContextArtifact[]> {
    const storePath = this.options.path ?? DEFAULT_KNOWLEDGE_PATH;
    const maxBytes = this.options.maxBytes ?? DEFAULT_KNOWLEDGE_MAX_BYTES;
    const limit = this.options.limit ?? DEFAULT_KNOWLEDGE_SEARCH_LIMIT;
    const provenance = this.options.provenance ?? "any";
    const machineIdPrefix =
      this.options.machineIdPrefix ?? DEFAULT_MACHINE_ID_PREFIX;
    const loaded = await loadKnowledgeStore(request.workspacePath, storePath);
    const eligible = loaded.notes.filter(
      (note) =>
        noteMatchesTags(note, this.options.tags) &&
        noteMatchesProvenance(note, provenance, machineIdPrefix),
    );
    const result = admitNotesByBudget(eligible, { limit, maxBytes });
    const admission: KnowledgeAdmission = {
      admitted: result.admitted.map((note) => note.id),
      omitted: result.omitted.map((note) => note.id),
      ...(result.bound === undefined ? {} : { bound: result.bound }),
    };
    return [
      ...noteArtifacts("knowledge-search", result.admitted, result.contents),
      ...metaArtifacts("knowledge-search", loaded.skipped, admission),
    ];
  }
}
