import { resolve } from "node:path";
import {
  applySelectionCommand,
  readSelectionDocument,
  writeSelectionDocument,
} from "@aguil/agents-workflow";

export async function runPrFeedbackSelectCli(
  argv: readonly string[],
): Promise<number> {
  let workspace = process.cwd();
  let selectionId: string | undefined;
  let list = false;
  const approve: string[] = [];
  const dismiss: string[] = [];
  const revoke: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const t = argv[i];
    if (t === "--help" || t === "-h") {
      printUsage();
      return 0;
    }
    if (t === "--workspace") {
      workspace = resolve(argv[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (t.startsWith("--workspace=")) {
      workspace = resolve(t.slice("--workspace=".length));
      i += 1;
      continue;
    }
    if (t === "--selection-id") {
      selectionId = argv[i + 1];
      i += 2;
      continue;
    }
    if (t.startsWith("--selection-id=")) {
      selectionId = t.slice("--selection-id=".length);
      i += 1;
      continue;
    }
    if (t === "--list") {
      list = true;
      i += 1;
      continue;
    }
    if (t === "--approve") {
      const v = argv[i + 1];
      if (v !== undefined) {
        approve.push(v);
      }
      i += 2;
      continue;
    }
    if (t.startsWith("--approve=")) {
      approve.push(t.slice("--approve=".length));
      i += 1;
      continue;
    }
    if (t === "--dismiss") {
      const v = argv[i + 1];
      if (v !== undefined) {
        dismiss.push(v);
      }
      i += 2;
      continue;
    }
    if (t.startsWith("--dismiss=")) {
      dismiss.push(t.slice("--dismiss=".length));
      i += 1;
      continue;
    }
    if (t === "--revoke") {
      const v = argv[i + 1];
      if (v !== undefined) {
        revoke.push(v);
      }
      i += 2;
      continue;
    }
    if (t.startsWith("--revoke=")) {
      revoke.push(t.slice("--revoke=".length));
      i += 1;
      continue;
    }
    console.error(`Unknown argument: ${t}`);
    printUsage();
    return 1;
  }

  const doc = await readSelectionDocument(workspace);

  if (list) {
    console.log(JSON.stringify(doc, null, 2));
    return 0;
  }

  if (approve.length === 0 && dismiss.length === 0 && revoke.length === 0) {
    console.error("Specify --approve, --dismiss, and/or --revoke.");
    printUsage();
    return 1;
  }

  try {
    const updated = applySelectionCommand({
      doc,
      selectionId,
      approve,
      dismiss,
      revoke,
    });
    await writeSelectionDocument(workspace, updated);
    console.log(
      JSON.stringify({
        event: "pr_feedback_selection_updated",
        selection_id: updated.selectionId,
        approved: updated.approved,
        dismissed: updated.dismissed,
        pending_count: updated.pending.length,
      }),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}

function printUsage(): void {
  console.log(`Usage: agents pr-feedback select [options]

Options:
  --workspace <path>       Host workspace (default: cwd)
  --selection-id <id>      Selection batch id from notification
  --list                   Print current selection document (JSON)
  --approve <owner/repo#n> Approve PR(s) for agentsd dispatch (repeatable)
  --dismiss <owner/repo#n> Dismiss PR(s) from pending (repeatable)
  --revoke <owner/repo#n>  Remove PR(s) from approved (repeatable)

Example:
  agents pr-feedback select --selection-id sel-abc --approve aguil/agents#33
`);
}
