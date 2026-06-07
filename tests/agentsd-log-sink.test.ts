import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAgentsdLogLine,
  resolveAgentsdLogSinkPath,
} from "../packages/agentsd/src/log-sink";

test("resolveAgentsdLogSinkPath reads AGENTSD_LOG_FILE", () => {
  expect(
    resolveAgentsdLogSinkPath({ AGENTSD_LOG_FILE: "/tmp/agentsd.jsonl" }),
  ).toBe("/tmp/agentsd.jsonl");
  expect(resolveAgentsdLogSinkPath({})).toBeNull();
});

test("appendAgentsdLogLine writes JSONL lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "log-sink-"));
  const path = join(dir, "agentsd.jsonl");
  try {
    const env = { AGENTSD_LOG_FILE: path };
    await appendAgentsdLogLine('{"event":"one"}', env);
    await appendAgentsdLogLine('{"event":"two"}', env);
    const raw = await readFile(path, "utf8");
    expect(raw.trim().split("\n")).toEqual([
      '{"event":"one"}',
      '{"event":"two"}',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
