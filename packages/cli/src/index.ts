import { createCodeReviewAdapter, runCodeReview } from "@aguil/agents-code-review";
import type { CodeReviewAdapterName } from "@aguil/agents-code-review";

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(`Usage: agents <command> [options]

Commands:
  run code-review        Run the code-review harness

Options:
  --workspace <path>     Workspace to review (default: cwd)
  --scratchpad <path>    Scratchpad root (default: <workspace>/.review-agent/runs)
  --adapter <name>       Execution adapter: fake, opencode, or claude (default: fake)
  --model <id>           Model passed to opencode
  --agent <name>         OpenCode agent name
  --opencode <path>      OpenCode executable (default: opencode)
  --claude <path>        Claude Code executable (default: claude)
  --claude-args <value>  Comma-separated arg template for Claude (supports {prompt})
  --pure                 Run opencode without external plugins
  --print-logs           Ask opencode to print logs to stderr`);
    return 0;
  }

  if (argv[0] === "run" && argv[1] === "code-review") {
    const options = parseOptions(argv.slice(2));
    const adapterName = parseAdapterName(options.adapter);
    if (adapterName === undefined) {
      console.error(`Unsupported adapter: ${options.adapter}`);
      return 1;
    }
    const adapter = createCodeReviewAdapter(adapterName, {
      opencode: {
        executable: options.opencode,
        model: options.model,
        agent: options.agent,
        pure: options.pure,
        printLogs: options.printLogs,
      },
      claude: {
        executable: options.claude,
        model: options.model,
        argsTemplate: parseCommaSeparated(options.claudeArgs),
      },
    });

    const result = await runCodeReview({
      workspacePath: options.workspace,
      scratchpadRoot: options.scratchpad,
      adapter,
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
  readonly model?: string;
  readonly agent?: string;
  readonly opencode?: string;
  readonly claude?: string;
  readonly claudeArgs?: string;
  readonly pure: boolean;
  readonly printLogs: boolean;
}

function parseOptions(argv: readonly string[]): CliOptions {
  const options: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags.add(key);
      continue;
    }
    options[key] = value;
    index += 1;
  }
  return {
    workspace: options.workspace,
    scratchpad: options.scratchpad,
    adapter: options.adapter,
    model: options.model,
    agent: options.agent,
    opencode: options.opencode,
    claude: options.claude,
    claudeArgs: options["claude-args"],
    pure: flags.has("pure"),
    printLogs: flags.has("print-logs"),
  };
}

function parseAdapterName(value: string | undefined): CodeReviewAdapterName | undefined {
  if (value === undefined || value === "fake" || value === "opencode" || value === "claude") {
    return value ?? "fake";
  }
  return undefined;
}

function parseCommaSeparated(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}
