import { runCodeReview } from "@aguil/agents-code-review";

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(`Usage: agents <command> [options]

Commands:
  run code-review        Run the code-review harness

Options:
  --workspace <path>     Workspace to review (default: cwd)
  --scratchpad <path>    Scratchpad root (default: <workspace>/.review-agent/runs)
  --adapter <name>       Execution adapter (currently: fake)`);
    return 0;
  }

  if (argv[0] === "run" && argv[1] === "code-review") {
    const options = parseOptions(argv.slice(2));
    if (options.adapter !== undefined && options.adapter !== "fake") {
      console.error(`Unsupported adapter: ${options.adapter}`);
      return 1;
    }

    const result = await runCodeReview({
      workspacePath: options.workspace,
      scratchpadRoot: options.scratchpad,
    });
    console.log(`Code review ${result.status}. Report: ${result.reportPath}`);
    return result.status === "error" ? 1 : 0;
  }

  console.error(`Unknown command: ${argv[0]}`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}

interface CliOptions {
  readonly workspace?: string;
  readonly scratchpad?: string;
  readonly adapter?: string;
}

function parseOptions(argv: readonly string[]): CliOptions {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      continue;
    }
    options[arg.slice(2)] = value;
    index += 1;
  }
  return {
    workspace: options.workspace,
    scratchpad: options.scratchpad,
    adapter: options.adapter,
  };
}
