import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareKnowledgeNotesForAdmission,
  type KnowledgeNote,
  KnowledgeProvider,
  KnowledgeSearchProvider,
  loadKnowledgeStore,
  parseKnowledgeNoteSource,
} from "@aguil/agents-context";

async function withWorkspace<T>(
  fn: (workspacePath: string) => Promise<T>,
): Promise<T> {
  const workspacePath = await mkdtemp(join(tmpdir(), "knowledge-"));
  try {
    return await fn(workspacePath);
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
}

async function writeNote(
  workspacePath: string,
  relativePath: string,
  source: string,
): Promise<void> {
  const absolute = join(workspacePath, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, source);
}

function note(
  partial: Partial<KnowledgeNote> & Pick<KnowledgeNote, "id">,
): KnowledgeNote {
  return {
    title: partial.title ?? partial.id,
    context: partial.context ?? "search-only",
    tags: partial.tags ?? [],
    body: partial.body ?? "",
    sourcePath: partial.sourcePath ?? `${partial.id}.md`,
    ...(partial.updatedAt === undefined
      ? {}
      : { updatedAt: partial.updatedAt }),
    id: partial.id,
  };
}

test("parseKnowledgeNoteSource accepts a well-formed note", () => {
  const parsed = parseKnowledgeNoteSource(
    [
      "---",
      "id: pagination-off-by-one",
      "title: Pagination drops last item",
      "context: auto",
      "tags: [incident, pagination]",
      "updatedAt: 2026-08-01T12:00:00Z",
      "---",
      "",
      "Each page silently drops its final row.",
    ].join("\n"),
    "note.md",
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) {
    return;
  }
  expect(parsed.note.id).toBe("pagination-off-by-one");
  expect(parsed.note.title).toBe("Pagination drops last item");
  expect(parsed.note.context).toBe("auto");
  expect(parsed.note.tags).toEqual(["incident", "pagination"]);
  expect(parsed.note.updatedAt).toBe("2026-08-01T12:00:00Z");
  expect(parsed.note.body).toContain("silently drops");
});

test("parseKnowledgeNoteSource defaults missing context to search-only", () => {
  const parsed = parseKnowledgeNoteSource(
    ["---", "id: bare", "---", "body"].join("\n"),
    "bare.md",
  );
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.note.context).toBe("search-only");
    expect(parsed.note.title).toBe("bare");
  }
});

test("parseKnowledgeNoteSource skips notes without frontmatter", () => {
  const parsed = parseKnowledgeNoteSource("# just markdown\n", "plain.md");
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.skip.reason).toBe("no-frontmatter");
  }
});

test("parseKnowledgeNoteSource skips unterminated frontmatter", () => {
  const parsed = parseKnowledgeNoteSource(
    ["---", "id: open", "never closed"].join("\n"),
    "open.md",
  );
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.skip.reason).toBe("unterminated-frontmatter");
  }
});

test("parseKnowledgeNoteSource skips invalid YAML", () => {
  const parsed = parseKnowledgeNoteSource(
    ["---", "id: [unterminated", "---", "body"].join("\n"),
    "bad-yaml.md",
  );
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.skip.reason).toBe("invalid-yaml");
  }
});

test("parseKnowledgeNoteSource skips a missing id", () => {
  const parsed = parseKnowledgeNoteSource(
    ["---", "title: no id", "---", "body"].join("\n"),
    "no-id.md",
  );
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.skip.reason).toBe("missing-id");
  }
});

test("parseKnowledgeNoteSource skips an invalid context value", () => {
  const parsed = parseKnowledgeNoteSource(
    ["---", "id: x", "context: always", "---", "body"].join("\n"),
    "bad-context.md",
  );
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) {
    expect(parsed.skip.reason).toBe("invalid-field");
  }
});

test("loadKnowledgeStore returns empty for an absent store", async () => {
  await withWorkspace(async (workspacePath) => {
    const loaded = await loadKnowledgeStore(workspacePath);
    expect(loaded.notes).toEqual([]);
    expect(loaded.skipped).toEqual([]);
  });
});

test("loadKnowledgeStore reads flat and nested layouts, reports duplicates", async () => {
  await withWorkspace(async (workspacePath) => {
    await writeNote(
      workspacePath,
      ".agents/knowledge/flat.md",
      ["---", "id: flat", "context: auto", "---", "flat body"].join("\n"),
    );
    await writeNote(
      workspacePath,
      ".agents/knowledge/nested/nested.md",
      ["---", "id: nested", "---", "nested body"].join("\n"),
    );
    await writeNote(
      workspacePath,
      ".agents/knowledge/dup.md",
      ["---", "id: flat", "---", "duplicate"].join("\n"),
    );
    const loaded = await loadKnowledgeStore(workspacePath);
    expect(loaded.notes.map((entry) => entry.id).sort()).toEqual([
      "flat",
      "nested",
    ]);
    expect(loaded.skipped.some((skip) => skip.reason === "duplicate-id")).toBe(
      true,
    );
  });
});

test("loadKnowledgeStore refuses symlink escapes outside the workspace", async () => {
  await withWorkspace(async (workspacePath) => {
    const outside = join(workspacePath, "..", "knowledge-escape.md");
    await writeFile(
      outside,
      ["---", "id: escape", "context: auto", "---", "secret"].join("\n"),
    );
    try {
      await mkdir(join(workspacePath, ".agents", "knowledge"), {
        recursive: true,
      });
      await symlink(
        outside,
        join(workspacePath, ".agents", "knowledge", "linked.md"),
      );
      const loaded = await loadKnowledgeStore(workspacePath);
      expect(loaded.notes).toEqual([]);
      expect(
        loaded.skipped.some((skip) => skip.reason === "outside-workspace"),
      ).toBe(true);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("loadKnowledgeStore bounds per-file reads", async () => {
  await withWorkspace(async (workspacePath) => {
    const body = "x".repeat(80_000);
    await writeNote(
      workspacePath,
      ".agents/knowledge/huge.md",
      ["---", "id: huge", "context: auto", "---", body].join("\n"),
    );
    const loaded = await loadKnowledgeStore(workspacePath);
    expect(loaded.notes).toHaveLength(1);
    expect(loaded.notes[0]?.body.length).toBeLessThan(body.length);
    expect(loaded.notes[0]?.body).toContain("[truncated at");
    expect(
      Buffer.byteLength(loaded.notes[0]?.body ?? "", "utf8"),
    ).toBeLessThanOrEqual(50_000 + 64);
  });
});

test("loadKnowledgeStore reports scan truncation past the path cap", async () => {
  await withWorkspace(async (workspacePath) => {
    for (let i = 0; i < 5; i += 1) {
      await writeNote(
        workspacePath,
        `.agents/knowledge/n${i}.md`,
        ["---", `id: n${i}`, "---", "body"].join("\n"),
      );
    }
    const loaded = await loadKnowledgeStore(
      workspacePath,
      ".agents/knowledge",
      {
        maxScanned: 3,
      },
    );
    expect(loaded.notes.length).toBe(3);
    expect(
      loaded.skipped.some((skip) => skip.reason === "scan-truncated"),
    ).toBe(true);
  });
});

test("admission order is updatedAt desc then id asc", () => {
  const ordered = [
    note({ id: "b", updatedAt: "2026-01-01T00:00:00Z" }),
    note({ id: "a", updatedAt: "2026-01-02T00:00:00Z" }),
    note({ id: "c" }),
    note({ id: "d", updatedAt: "2026-01-02T00:00:00Z" }),
  ].sort(compareKnowledgeNotesForAdmission);
  expect(ordered.map((entry) => entry.id)).toEqual(["a", "d", "b", "c"]);
});

test("KnowledgeProvider meta artifact ids do not collide with note ids", async () => {
  await withWorkspace(async (workspacePath) => {
    await writeNote(
      workspacePath,
      ".agents/knowledge/admission.md",
      [
        "---",
        "id: admission",
        "context: auto",
        "updatedAt: 2026-01-01T00:00:00Z",
        "---",
        "note named admission",
      ].join("\n"),
    );
    await writeNote(
      workspacePath,
      ".agents/knowledge/extra.md",
      [
        "---",
        "id: extra",
        "context: auto",
        "updatedAt: 2025-01-01T00:00:00Z",
        "---",
        "older",
      ].join("\n"),
    );
    const artifacts = await new KnowledgeProvider({ maxNotes: 1 }).collect({
      workspacePath,
      scratchpadPath: join(workspacePath, ".scratch"),
    });
    const ids = artifacts.map((artifact) => artifact.id);
    expect(ids).toContain("knowledge:admission");
    expect(ids).toContain("knowledge:_meta:admission");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

test("KnowledgeProvider injects only context:auto notes within budget", async () => {
  await withWorkspace(async (workspacePath) => {
    // Names chosen so directory order would prefer older notes; admission
    // must follow updatedAt instead (ADR 0022 §7).
    await writeNote(
      workspacePath,
      ".agents/knowledge/zzz-old.md",
      [
        "---",
        "id: old",
        "context: auto",
        "updatedAt: 2026-01-01T00:00:00Z",
        "---",
        "old",
      ].join("\n"),
    );
    await writeNote(
      workspacePath,
      ".agents/knowledge/aaa-new.md",
      [
        "---",
        "id: new",
        "context: auto",
        "updatedAt: 2026-06-01T00:00:00Z",
        "---",
        "new",
      ].join("\n"),
    );
    await writeNote(
      workspacePath,
      ".agents/knowledge/search-only.md",
      [
        "---",
        "id: search-only",
        "tags: [security]",
        "---",
        "not injected",
      ].join("\n"),
    );
    await writeNote(
      workspacePath,
      ".agents/knowledge/mid.md",
      [
        "---",
        "id: mid",
        "context: auto",
        "updatedAt: 2026-03-01T00:00:00Z",
        "---",
        "mid",
      ].join("\n"),
    );

    const provider = new KnowledgeProvider({ maxNotes: 2 });
    const artifacts = await provider.collect({
      workspacePath,
      scratchpadPath: join(workspacePath, ".scratch"),
    });
    const noteIds = artifacts
      .filter((artifact) => artifact.id.startsWith("knowledge:"))
      .filter((artifact) => !artifact.id.endsWith(":_meta:admission"))
      .filter((artifact) => !artifact.id.endsWith(":_meta:skipped"))
      .map((artifact) => artifact.id);
    expect(noteIds).toEqual(["knowledge:new", "knowledge:mid"]);
    const admission = artifacts.find(
      (artifact) => artifact.id === "knowledge:_meta:admission",
    );
    expect(admission?.content).toContain('"omitted"');
    expect(admission?.content).toContain("old");
    expect(admission?.content).toContain("max_notes");
  });
});

test("KnowledgeProvider does not fail when the store exceeds the budget", async () => {
  await withWorkspace(async (workspacePath) => {
    for (let i = 0; i < 12; i += 1) {
      await writeNote(
        workspacePath,
        `.agents/knowledge/n${String(i).padStart(2, "0")}.md`,
        [
          "---",
          `id: note-${i}`,
          "context: auto",
          `updatedAt: 2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
          "---",
          `body ${i}`,
        ].join("\n"),
      );
    }
    const artifacts = await new KnowledgeProvider().collect({
      workspacePath,
      scratchpadPath: join(workspacePath, ".scratch"),
    });
    const notes = artifacts.filter(
      (artifact) =>
        artifact.id.startsWith("knowledge:") &&
        !artifact.id.endsWith(":_meta:admission") &&
        !artifact.id.endsWith(":_meta:skipped"),
    );
    expect(notes).toHaveLength(10);
    expect(
      artifacts.some((artifact) => artifact.id === "knowledge:_meta:admission"),
    ).toBe(true);
  });
});

test("KnowledgeSearchProvider matches tags with AND and filters provenance", async () => {
  await withWorkspace(async (workspacePath) => {
    await writeNote(
      workspacePath,
      ".agents/knowledge/sec.md",
      [
        "---",
        "id: human-sec",
        "tags: [Security, incident]",
        "---",
        "human",
      ].join("\n"),
    );
    await writeNote(
      workspacePath,
      ".agents/knowledge/machine.md",
      [
        "---",
        "id: harness:auto-find",
        "tags: [security]",
        "---",
        "machine",
      ].join("\n"),
    );
    await writeNote(
      workspacePath,
      ".agents/knowledge/other.md",
      ["---", "id: other", "tags: [ops]", "---", "other"].join("\n"),
    );

    const andMatch = await new KnowledgeSearchProvider({
      tags: ["security", "incident"],
    }).collect({
      workspacePath,
      scratchpadPath: join(workspacePath, ".scratch"),
    });
    expect(
      andMatch
        .filter((artifact) => artifact.id.startsWith("knowledge-search:"))
        .filter((artifact) => !artifact.id.includes(":_meta:admission"))
        .filter((artifact) => !artifact.id.includes(":_meta:skipped"))
        .map((artifact) => artifact.id),
    ).toEqual(["knowledge-search:human-sec"]);

    const machineOnly = await new KnowledgeSearchProvider({
      tags: ["security"],
      provenance: "machine",
    }).collect({
      workspacePath,
      scratchpadPath: join(workspacePath, ".scratch"),
    });
    expect(
      machineOnly.some(
        (artifact) => artifact.id === "knowledge-search:harness:auto-find",
      ),
    ).toBe(true);
    expect(
      machineOnly.some(
        (artifact) => artifact.id === "knowledge-search:human-sec",
      ),
    ).toBe(false);

    const empty = await new KnowledgeSearchProvider({
      tags: ["nonexistent"],
    }).collect({
      workspacePath,
      scratchpadPath: join(workspacePath, ".scratch"),
    });
    expect(
      empty
        .filter((artifact) => artifact.id.startsWith("knowledge-search:"))
        .filter(
          (artifact) =>
            !artifact.id.endsWith(":_meta:admission") &&
            !artifact.id.endsWith(":_meta:skipped"),
        ),
    ).toHaveLength(0);
  });
});

test("KnowledgeProvider admits oversized notes in truncated form", async () => {
  await withWorkspace(async (workspacePath) => {
    await writeNote(
      workspacePath,
      ".agents/knowledge/big.md",
      ["---", "id: big", "context: auto", "---", "y".repeat(150)].join("\n"),
    );
    const artifacts = await new KnowledgeProvider({ maxBytes: 100 }).collect({
      workspacePath,
      scratchpadPath: join(workspacePath, ".scratch"),
    });
    const noteArtifact = artifacts.find(
      (artifact) => artifact.id === "knowledge:big",
    );
    expect(noteArtifact).toBeDefined();
    expect(noteArtifact?.content).toContain("[truncated at");
    expect(
      Buffer.byteLength(noteArtifact?.content ?? "", "utf8"),
    ).toBeLessThanOrEqual(100);
    expect(
      artifacts.some((artifact) => artifact.id === "knowledge:_meta:admission"),
    ).toBe(false);
  });
});

test("KnowledgeSearchProvider honors limit without requiring context:auto", async () => {
  await withWorkspace(async (workspacePath) => {
    for (const id of ["a", "b", "c"]) {
      await writeNote(
        workspacePath,
        `.agents/knowledge/${id}.md`,
        ["---", `id: ${id}`, "tags: [t]", "---", id].join("\n"),
      );
    }
    const artifacts = await new KnowledgeSearchProvider({
      tags: ["t"],
      limit: 2,
    }).collect({
      workspacePath,
      scratchpadPath: join(workspacePath, ".scratch"),
    });
    const notes = artifacts.filter(
      (artifact) =>
        artifact.id.startsWith("knowledge-search:") &&
        !artifact.id.endsWith(":_meta:admission") &&
        !artifact.id.endsWith(":_meta:skipped"),
    );
    expect(notes).toHaveLength(2);
  });
});
