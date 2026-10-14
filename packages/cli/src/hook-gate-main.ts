import { decideHookGate, parseHookGateArgv } from "@aguil/agents-hooks";

/** Signals an adapter may end a hook with; the handler is ended with it. */
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * `agents hook-gate` (ADR 0028 decision 2): run a harness-declared tool-call
 * handler only when this call is in its scope. The payload reaches the
 * handler unchanged, and its stdout, stderr and exit status reach the
 * adapter unchanged. A skip prints nothing: on Claude Code an allow would
 * lift the headless permission default (decision 4).
 */
export async function runHookGateCli(argv: readonly string[]): Promise<number> {
  const args = parseHookGateArgv(argv);
  if (typeof args === "string") {
    console.error(args);
    return 1;
  }
  // The start-up probe proves the command parses and the matcher compiles;
  // it reads no stdin and runs no handler (decision 7).
  if (args.probe) {
    return 0;
  }
  const payload = new Uint8Array(await Bun.stdin.arrayBuffer());
  const decision = decideHookGate(args, new TextDecoder().decode(payload));
  if (decision.action === "skip") {
    return 0;
  }
  if (decision.action === "report") {
    process.stderr.write(`${decision.report}\n`);
  }
  const proc = Bun.spawn({
    cmd: ["/bin/sh", "-c", args.command],
    stdin: payload,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ...(args.matcher === undefined ? {} : { HOOK_MATCHER: args.matcher }),
    },
  });
  // The adapter's own hook timeout bounds the gate and the handler together;
  // when it ends the gate, it ends the handler too.
  const forward = (signal: NodeJS.Signals) => () => {
    proc.kill(signal);
  };
  const handlers = FORWARDED_SIGNALS.map(
    (signal) => [signal, forward(signal)] as const,
  );
  for (const [signal, handler] of handlers) {
    process.on(signal, handler);
  }
  try {
    const exitCode = await proc.exited;
    const signal = proc.signalCode;
    if (signal !== null && signal !== undefined) {
      const number = (await import("node:os")).constants.signals[signal];
      return 128 + (number ?? 0);
    }
    return exitCode;
  } finally {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  }
}
