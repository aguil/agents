import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encode } from "@toon-format/toon";
import { assertResolvedPathInsideWorkspace } from "./safe-path";
import type { TriageEnvelopeV1 } from "./types";

export type TriageSerializationFormat = "json" | "toon" | "both";

const TRIAGE_JSON = "triage-queue.json";
const TRIAGE_TOON = "triage-queue.toon";

function toLosslessPlainObject(
  envelope: TriageEnvelopeV1,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(envelope)) as Record<string, unknown>;
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

  await mkdir(options.outputDir, { recursive: true });
  await assertResolvedPathInsideWorkspace(
    options.envelope.workspacePath,
    options.outputDir,
  );

  const writes: Promise<void>[] = [];
  if (options.format === "json" || options.format === "both") {
    const jsonPath = join(options.outputDir, TRIAGE_JSON);
    writes.push(
      writeFile(jsonPath, `${JSON.stringify(plain, null, 2)}\n`, "utf8"),
    );
  }
  if (options.format === "toon" || options.format === "both") {
    const toonPath = join(options.outputDir, TRIAGE_TOON);
    writes.push(writeFile(toonPath, `${encode(plain)}\n`, "utf8"));
  }
  await Promise.all(writes);
}
