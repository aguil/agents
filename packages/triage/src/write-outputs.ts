import { constants as fsc } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { encode } from "@toon-format/toon";
import {
  assertOutputDirectoryWillResolveInsideWorkspace,
  assertResolvedPathInsideWorkspace,
} from "./safe-path";
import type { TriageEnvelopeV1 } from "./types";

export type TriageSerializationFormat = "json" | "toon" | "both";

const TRIAGE_JSON = "triage-queue.json";
const TRIAGE_TOON = "triage-queue.toon";

function toLosslessPlainObject(
  envelope: TriageEnvelopeV1,
): Record<string, unknown> {
  return structuredClone(envelope) as unknown as Record<string, unknown>;
}

async function writeUtf8FileNoFollow(
  path: string,
  body: string,
): Promise<void> {
  const nofollow = fsc.O_NOFOLLOW ?? 0;
  const fh = await open(
    path,
    fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | nofollow,
    0o644,
  );
  try {
    await fh.writeFile(body, "utf8");
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Write serialized triage envelopes to disk or stdout. */
export async function writeTriageOutputs(options: {
  readonly envelope: TriageEnvelopeV1;
  readonly outputDir: string;
  readonly format: TriageSerializationFormat;
  readonly stdout?: boolean;
  readonly stdoutFormat?: "json" | "toon";
}): Promise<void> {
  const plain = toLosslessPlainObject(options.envelope);

  if (options.stdout === true) {
    const sf = options.stdoutFormat;
    if (sf !== "json" && sf !== "toon") {
      throw new Error("--stdout requires --format json or --format toon.");
    }
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

  const { candidateReal } = await assertResolvedPathInsideWorkspace(
    workspacePath,
    outputAbs,
  );

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
