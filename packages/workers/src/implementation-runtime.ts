import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CodeReviewAdapterName,
  createCodeReviewAdapter,
} from "@aguil/agents-code-review";
import { createRunId, ensureDirectory } from "@aguil/agents-core";
import type { AgentAdapter } from "@aguil/agents-execution";
import {
  collectAgentRun,
  FakeAgentAdapter,
  FakeAgentSessionClient,
  SessionAgentAdapterClient,
  sessionEventToAgentEvent,
} from "@aguil/agents-execution";
import type { WorkItem } from "@aguil/agents-tracker";
import type {
  ImplementationExecutionConfig,
  WorkflowDefinition,
} from "@aguil/agents-workflow";

const PRIVATE_DIR_MODE = 0o700;

export function createSubprocessAdapter(
  impl: ImplementationExecutionConfig,
): AgentAdapter {
  const name = impl.adapter as CodeReviewAdapterName;
  if (name === "fake") {
    return new FakeAgentAdapter();
  }
  return createCodeReviewAdapter(name);
}

export function createSessionClient(
  impl: ImplementationExecutionConfig,
): FakeAgentSessionClient | SessionAgentAdapterClient {
  if (impl.command === null) {
    return new FakeAgentSessionClient({ protocol: impl.protocol ?? "fake" });
  }
  return new SessionAgentAdapterClient({
    command: impl.command,
    protocol: impl.protocol ?? "app_server",
    stallTimeoutMs: impl.stallTimeoutMs,
  });
}

export async function runImplementationSubprocess(input: {
  readonly item: WorkItem;
  readonly workspacePath: string;
  readonly prompt: string;
  readonly impl: ImplementationExecutionConfig;
  readonly timeoutMs: number;
}): Promise<{
  readonly status: "succeeded" | "failed";
  readonly error?: string;
}> {
  const runId = createRunId("implementation");
  const scratchpadPath = join(
    input.workspacePath,
    ".agents-implementation",
    runId,
  );
  await ensureDirectory(scratchpadPath);
  await writeFile(
    join(scratchpadPath, "prompt.md"),
    `${input.prompt}\n`,
    "utf8",
  );

  const adapter = createSubprocessAdapter(input.impl);
  const result = await collectAgentRun(adapter, {
    runId,
    roleId: "implementation",
    prompt: input.prompt,
    workspacePath: input.workspacePath,
    contextBundlePath: join(scratchpadPath, "context.json"),
    scratchpadPath,
    timeoutMs: input.timeoutMs,
    allowedCommands: [],
    metadata: {
      work_item_id: input.item.id,
      identifier: input.item.identifier,
    },
  });

  const runStatus = result.result.status;
  if (runStatus === "failed" || runStatus === "timed_out") {
    return { status: "failed", error: `adapter ${runStatus}` };
  }
  return { status: "succeeded" };
}

export async function runImplementationAppServer(input: {
  readonly item: WorkItem;
  readonly workspacePath: string;
  readonly prompt: string;
  readonly definition: WorkflowDefinition;
}): Promise<{
  readonly status: "succeeded" | "failed";
  readonly error?: string;
}> {
  const runId = createRunId("implementation");
  const scratchpadPath = join(
    input.workspacePath,
    ".agents-implementation",
    runId,
  );
  await mkdir(scratchpadPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  await writeFile(
    join(scratchpadPath, "prompt.md"),
    `${input.prompt}\n`,
    "utf8",
  );

  const impl = input.definition.implementation;
  const client = createSessionClient(impl);
  const maxTurns = input.definition.maxTurns;
  const timeoutMs = impl.turnTimeoutMs ?? 3_600_000;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const stream =
      turn === 0
        ? client.startSession({
            runId,
            workspacePath: input.workspacePath,
            scratchpadPath,
            prompt: input.prompt,
            timeoutMs,
          })
        : client.continueTurn({
            runId,
            guidance:
              "Continue working on the task. Do not repeat the full original prompt.",
            turnIndex: turn,
          });

    let failed = false;
    for await (const sessionEvent of stream) {
      const agentEvent = sessionEventToAgentEvent(
        runId,
        "implementation",
        sessionEvent,
      );
      if (agentEvent.type === "error") {
        failed = true;
      }
    }
    if (failed) {
      return { status: "failed", error: `session turn ${turn} failed` };
    }
  }

  return { status: "succeeded" };
}
