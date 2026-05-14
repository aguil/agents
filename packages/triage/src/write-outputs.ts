import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { encode } from "@toon-format/toon";
import { writeUtf8FileNoFollow } from "./no-follow-io";
import {
  assertOutputDirectoryWillResolveInsideWorkspace,
  assertResolvedPathInsideWorkspace,
} from "./safe-path";
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
    process.stdout.write(`${encode(plain)}\n`);
    return;
  }

  const workspacePath = options.envelope.workspacePath;
  const outputAbs = resolve(options.outputDir);
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

  const plain = options.envelope as unknown as Record<string, unknown>;

  const writes: Promise<void>[] = [];
  if (options.format === "json" || options.format === "both") {
    const jsonPath = join(candidateReal, TRIAGE_JSON);
    writes.push(
      writeUtf8FileNoFollow(jsonPath, `${JSON.stringify(plain, null, 2)}\n`),
    );
  }
  if (options.format === "toon" || options.format === "both") {
    const toonPath = join(candidateReal, TRIAGE_TOON);
    writes.push(writeUtf8FileNoFollow(toonPath, `${encode(plain)}\n`));
  }
  await Promise.all(writes);
}
