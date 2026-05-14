import { resolve } from "node:path";
import {
  buildEnvelopeFromCodeReviewResult,
  defaultTriageQueueDir,
  resolveCodeReviewResultPath,
  writeTriageOutputs,
} from "@aguil/agents-triage";
import {
  parseTriageArgv,
  stripLegacyTriageIngestArgv,
} from "./parse-triage-argv";

const CODE_REVIEW_PRODUCER = "code-review";

/** Full argv after script name (includes leading `triage`). */
export async function runTriageCli(argv: readonly string[]): Promise<number> {
  if (argv[0] !== "triage") {
    console.error("Internal error: expected `triage` argv header.");
    return 2;
  }
  const tail = stripLegacyTriageIngestArgv(argv.slice(1));

  const parsed = parseTriageArgv(tail);
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error("Try 'agents triage --help'.");
    return 1;
  }

  const opt = parsed.options;
  const workspacePath = resolve(opt.workspace ?? process.cwd());

  if (opt.from !== CODE_REVIEW_PRODUCER) {
    console.error(
      `Unsupported --from '${opt.from}' (only '${CODE_REVIEW_PRODUCER}' in this release).`,
    );
    return 1;
  }

  try {
    const resultAbsolutePath = await resolveCodeReviewResultPath({
      workspacePath,
      resultPath: opt.result,
    });
    const envelope = await buildEnvelopeFromCodeReviewResult({
      workspacePath,
      resultAbsolutePath,
    });

    const outputDirResolved =
      opt.outputDir !== undefined
        ? resolve(workspacePath, opt.outputDir)
        : defaultTriageQueueDir(workspacePath, envelope.outputSlug);

    await writeTriageOutputs({
      envelope,
      outputDir: outputDirResolved,
      format: opt.format,
      ...(opt.stdout === true
        ? {
            stdout: true,
            stdoutFormat: opt.format === "json" ? "json" : "toon",
          }
        : {}),
    });

    if (!opt.stdout) {
      console.log(`Triage envelope written under ${outputDirResolved}`);
    }

    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
