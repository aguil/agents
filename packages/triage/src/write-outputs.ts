import { mkdir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { writeUtf8FileNoFollow } from "./no-follow-io";
import {
  assertOutputDirectoryWillResolveInsideWorkspace,
  assertResolvedPathInsideWorkspace,
} from "./safe-path";
import { loadToonEncode } from "./toon-encode";
import type { TriageEnvelopeV1 } from "./types";

export type TriageSerializationFormat = "json" | "toon" | "both";

const TRIAGE_JSON = "triage-queue.json";
const TRIAGE_TOON = "triage-queue.toon";

/** Write serialized triage envelopes to disk or stdout. */
export async function writeTriageOutputs(options: {
  readonly envelope: TriageEnvelopeV1;
  readonly outputDir: string;
  readonly format: TriageSerializationFormat;
  readonly stdout?: boolean;
  readonly stdoutFormat?: "json" | "toon";
}): Promise<void> {
  if (options.stdout === true) {
    const sf = options.stdoutFormat;
    if (sf !== "json" && sf !== "toon") {
      throw new Error("--stdout requires --format json or --format toon.");
    }
    const plain = options.envelope as unknown as Record<string, unknown>;
    if (sf === "json") {
      process.stdout.write(`${JSON.stringify(plain, null, 2)}\n`);
      return;
    }
    const encode = await loadToonEncode();
    process.stdout.write(`${encode(plain)}\n`);
    return;
  }

  const workspacePath = options.envelope.workspacePath;
  const outputAbs = resolve(options.outputDir);
  // ADR 0002: pathname mkdir and writes after validation; openat deferred (accepted risk).
  await assertOutputDirectoryWillResolveInsideWorkspace(
    workspacePath,
    outputAbs,
  );
  await mkdir(outputAbs, { recursive: true });

  const firstResolved = await assertResolvedPathInsideWorkspace(
    workspacePath,
    outputAbs,
  );
  const { candidateReal } = await assertResolvedPathInsideWorkspace(
    workspacePath,
    outputAbs,
  );
  if (firstResolved.candidateReal !== candidateReal) {
    throw new Error(
      "Output directory resolution changed during triage write setup.",
    );
  }
  const rel = relative(firstResolved.workspaceReal, candidateReal);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error("Triage output directory escapes workspace.");
  }
  const anchoredDir = join(firstResolved.workspaceReal, rel);
  const dirRead = await realpath(anchoredDir);
  if (dirRead !== candidateReal) {
    throw new Error(
      "Output directory moved relative to workspace anchor before write.",
    );
  }
  const dirWrite = await realpath(anchoredDir);
  if (dirWrite !== dirRead) {
    throw new Error("Output directory moved immediately before write.");
  }

  const plain = options.envelope as unknown as Record<string, unknown>;

  const writes: Promise<void>[] = [];
  if (options.format === "json" || options.format === "both") {
    const jsonPath = join(dirWrite, TRIAGE_JSON);
    writes.push(
      writeUtf8FileNoFollow(jsonPath, `${JSON.stringify(plain, null, 2)}\n`),
    );
  }
  if (options.format === "toon" || options.format === "both") {
    const encode = await loadToonEncode();
    const toonPath = join(dirWrite, TRIAGE_TOON);
    writes.push(writeUtf8FileNoFollow(toonPath, `${encode(plain)}\n`));
  }
  await Promise.all(writes);
}
