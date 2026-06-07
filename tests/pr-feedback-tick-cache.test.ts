import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrFeedbackTickCache } from "@aguil/agents-tracker";
import {
  emptySelectionDocument,
  writeSelectionDocument,
} from "@aguil/agents-workflow";

test("PrFeedbackTickCache reuses selection reads within a tick", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sel-cache-"));
  try {
    await mkdir(join(dir, ".agentsd"), { recursive: true });
    await writeFile(
      join(dir, ".agentsd", "pr-feedback-selection.json"),
      `${JSON.stringify(emptySelectionDocument(), null, 2)}\n`,
      "utf8",
    );
    const cache = createPrFeedbackTickCache();
    const first = await cache.readSelection(dir);
    const second = await cache.readSelection(dir);
    expect(first.selectionId).toBe(second.selectionId);
    const updated = {
      ...first,
      approved: ["org/repo#1"],
    };
    await writeSelectionDocument(dir, updated);
    cache.noteSelectionWrite(dir, updated);
    const third = await cache.readSelection(dir);
    expect(third.approved).toEqual(["org/repo#1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
