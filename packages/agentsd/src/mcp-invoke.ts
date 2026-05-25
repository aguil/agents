import { resolve } from "node:path";

export type McpInvokeFn = (
  server: string,
  tool: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Load a host-provided MCP bridge from `AGENTSD_MCP_HANDLER` (absolute or cwd-relative
 * module path). The module must export `mcpInvoke` or a default function with the same
 * signature as {@link McpInvokeFn}.
 */
export async function loadMcpInvokeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpInvokeFn | undefined> {
  const raw = env.AGENTSD_MCP_HANDLER?.trim();
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const modulePath = resolve(raw);
  const mod = (await import(modulePath)) as {
    readonly mcpInvoke?: McpInvokeFn;
    readonly default?: McpInvokeFn;
  };
  const fn = mod.mcpInvoke ?? mod.default;
  if (typeof fn !== "function") {
    throw new Error(
      `AGENTSD_MCP_HANDLER module must export mcpInvoke or default function: ${modulePath}`,
    );
  }
  return fn;
}

/** JSON-line stdin/stdout bridge for a host script (`AGENTSD_MCP_COMMAND`). */
export function createCommandMcpInvoke(command: string): McpInvokeFn {
  return async (server, tool, input) => {
    const proc = Bun.spawn({
      cmd: ["bash", "-lc", command],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const payload = JSON.stringify({ server, tool, input });
    proc.stdin.write(payload);
    proc.stdin.end();
    const text = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    if (exit !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(
        `AGENTSD_MCP_COMMAND failed (exit ${exit}): ${err.trim() || text.trim()}`,
      );
    }
    const line = text.trim().split("\n").at(-1) ?? "{}";
    return JSON.parse(line) as unknown;
  };
}

export async function resolveMcpInvoke(input: {
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly explicit?: McpInvokeFn;
}): Promise<McpInvokeFn | undefined> {
  if (input.explicit !== undefined) {
    return input.explicit;
  }
  const env = input.env ?? process.env;
  if (!input.argv.includes("--with-mcp")) {
    return undefined;
  }
  const fromModule = await loadMcpInvokeFromEnv(env);
  if (fromModule !== undefined) {
    return fromModule;
  }
  const command = env.AGENTSD_MCP_COMMAND?.trim();
  if (command !== undefined && command.length > 0) {
    return createCommandMcpInvoke(command);
  }
  return defaultMcpInvoke;
}

async function defaultMcpInvoke(
  server: string,
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  console.warn(
    `[agentsd] MCP invoke not configured (server=${server}, tool=${tool}). ` +
      "Set AGENTSD_MCP_HANDLER or AGENTSD_MCP_COMMAND, or pass mcpInvoke to runAgentsd.",
    input,
  );
  return { issues: [] };
}
