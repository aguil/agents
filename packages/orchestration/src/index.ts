import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Finding,
  HarnessOutcome,
  HarnessRunRequest,
  HarnessRunResult,
} from "@aguil/agents-core";
import {
  ensureDirectory,
  findingToHarnessOutcome,
  isHarnessOutcome,
  writeJsonFile,
} from "@aguil/agents-core";
import type { AgentAdapter, AgentRunRequest } from "@aguil/agents-execution";
import { isFinding } from "@aguil/agents-execution";
import type { EventSink } from "@aguil/agents-telemetry";

export interface RoleDefinition {
  readonly id: string;
  readonly description: string;
  readonly prompt?: string;
  readonly promptPath?: string;
  /** CEL expression deciding whether the role runs for a given evaluation environment; absent = always enabled. */
  readonly enabledWhen?: string;
  readonly requiredCapabilities: readonly string[];
  readonly timeoutMs: number;
  readonly allowedCommands?: readonly string[];
}

export interface ParallelExecution {
  readonly mode: "parallel";
}

export interface ChainExecution {
  readonly mode: "chain";
  /** Step order; defaults to definition role order. */
  readonly order?: readonly string[];
  /**
   * v1 supports abort only: the first failed or timed-out step stops the
   * chain. Retry/skip semantics are deferred until a concrete harness
   * needs them.
   */
  readonly onStepFailure?: "abort";
  /**
   * Command run in the workspace after all roles complete to determine run
   * success (exit 0 => passed). The authoritative, deterministic pass gate —
   * the runtime wires it to the orchestrator's passGate. Runtime-evaluated
   * (not agent-reported) so diagnostic findings/outcomes cannot decide
   * status. Declared in harness.yaml (build-time trusted config, like hooks).
   */
  readonly passCheck?: readonly string[];
}

export interface ValidationLoopExecution {
  readonly mode: "validation-loop";
  readonly implementationRoles: readonly string[];
  readonly validationRoles: readonly string[];
  readonly maxRounds: number;
  /**
   * Pass condition over the round's validation outcomes. Defaults to
   * "validation roles produced zero outcomes". CEL expressions arrive in a
   * later phase; this stays a build-time predicate until then.
   */
  readonly passWhen?: (
    validationOutcomes: readonly HarnessOutcome[],
  ) => boolean;
}

export type ExecutionConfig =
  | ParallelExecution
  | ChainExecution
  | ValidationLoopExecution;

export interface HarnessDefinition {
  readonly id: string;
  readonly roles: readonly RoleDefinition[];
  readonly defaultAllowedCommands?: readonly string[];
  /** Absent means parallel fan-out (existing behavior). */
  readonly execution?: ExecutionConfig;
}

/**
 * Truncation limits for role output flowing between steps, matching the
 * limits pi-subagents ships (2000 lines / 50KB per subagent output) to
 * prevent chain-mode context overflow.
 */
export const ROLE_OUTPUT_MAX_BYTES = 50_000;
export const ROLE_OUTPUT_MAX_LINES = 2000;

export function truncateRoleOutput(
  output: string,
  maxBytes: number = ROLE_OUTPUT_MAX_BYTES,
  maxLines: number = ROLE_OUTPUT_MAX_LINES,
): string {
  let truncated = output;
  // Find the cut offset by scanning newlines instead of split(), so huge
  // outputs never materialize a per-line array.
  let cutOffset = -1;
  let newlines = 0;
  for (
    let index = output.indexOf("\n");
    index !== -1;
    index = output.indexOf("\n", index + 1)
  ) {
    newlines += 1;
    if (newlines === maxLines) {
      cutOffset = index;
      break;
    }
  }
  if (cutOffset !== -1 && cutOffset < output.length - 1) {
    let remaining = 0;
    for (
      let index = output.indexOf("\n", cutOffset + 1);
      index !== -1;
      index = output.indexOf("\n", index + 1)
    ) {
      remaining += 1;
    }
    // Lines beyond the cut: one for the partial after cutOffset plus one
    // per remaining newline (matches previous split-based accounting).
    truncated = `${output.slice(0, cutOffset)}\n[truncated: ${remaining + 1} more lines]`;
  }
  if (Buffer.byteLength(truncated, "utf8") > maxBytes) {
    truncated = `${Buffer.from(truncated, "utf8").subarray(0, maxBytes).toString("utf8")}\n[truncated at ${maxBytes} bytes]`;
  }
  return truncated;
}

/** Fan-out harness roles for a single run (see ADR 0003). */
export interface HarnessOrchestrator {
  run(request: HarnessRunRequest): Promise<HarnessRunResult>;
}

/** @deprecated Use {@link HarnessOrchestrator}. */
export type Orchestrator = HarnessOrchestrator;

export interface NativeBunOrchestratorOptions {
  readonly definition: HarnessDefinition;
  readonly adapter: AgentAdapter;
  readonly eventSink?: EventSink;
  readonly contextBundlePath: string;
  readonly embeddedPrompts?: Readonly<Record<string, string>>;
  /**
   * Invoked immediately before each role runs. Lets the caller apply
   * role-scoped setup — notably regenerating adapter hook config with the
   * role's effective policy. Awaited; a throw aborts the run. Safe for
   * sequential modes (chain, validation-loop rounds); for parallel mode
   * callbacks may interleave, so only use it there for role-independent
   * setup.
   */
  readonly onRoleStart?: (roleId: string) => Promise<void> | void;
  /**
   * Per-role environment merged into each role's agent subprocess spawn.
   * Unlike onRoleStart (shared-file mutation, sequencing-sensitive), env is
   * process-scoped and therefore safe in all execution modes including
   * parallel.
   */
  readonly roleEnv?: (
    roleId: string,
  ) => Readonly<Record<string, string>> | undefined;
  /**
   * Authoritative pass gate for execution-configured (generalized)
   * harnesses. Evaluated after all roles complete without failing/timing
   * out; `false` makes the run `failed`, `true`/absent makes it `passed`.
   *
   * Deliberately runtime-evaluated rather than inferred from role output:
   * findings/outcomes emitted by a real agent are diagnostic narrative and
   * must not drive status (a healed incident whose scout described the bug
   * as "critical" must still pass). Callers wire this to a deterministic
   * check — e.g. running the harness's `pass_check` command in the
   * workspace. Ignored for legacy harnesses (no `execution` config), which
   * keep finding-severity status.
   */
  readonly passGate?: (result: {
    readonly findings: readonly Finding[];
    readonly outcomes: readonly HarnessOutcome[];
  }) => Promise<boolean> | boolean;
}

interface RoleRunOutcome {
  readonly roleId: string;
  readonly findings: readonly Finding[];
  readonly genericOutcomes: readonly HarnessOutcome[];
  readonly artifacts: readonly string[];
  readonly outcome: "completed" | "timed_out" | "failed";
}

interface PromptInterpolationContext {
  readonly previous?: string;
  readonly outputs?: Readonly<Record<string, string>>;
  readonly validation?: string;
}

export class NativeBunOrchestrator implements HarnessOrchestrator {
  constructor(private readonly options: NativeBunOrchestratorOptions) {}

  async run(request: HarnessRunRequest): Promise<HarnessRunResult> {
    await ensureDirectory(request.scratchpadPath);
    assertAdapterCapabilities(this.options.adapter, this.options.definition);

    const execution = this.options.definition.execution ?? {
      mode: "parallel" as const,
    };
    let roleOutcomes: readonly RoleRunOutcome[];
    const extraMetadata: Record<string, string> = {
      execution_mode: execution.mode,
    };
    // Internal convergence gate (validation-loop only): false => the loop
    // exhausted maxRounds without satisfying passWhen, which must fail the
    // run independently of the external passGate.
    let internalGatePassed: boolean | undefined;

    switch (execution.mode) {
      case "parallel":
        roleOutcomes = await this.runParallel(request);
        break;
      case "chain":
        roleOutcomes = await this.runChain(request, execution);
        break;
      case "validation-loop": {
        const loop = await this.runValidationLoop(request, execution);
        roleOutcomes = loop.roleOutcomes;
        extraMetadata.validation_rounds = String(loop.rounds);
        extraMetadata.validation_passed = String(loop.passed);
        internalGatePassed = loop.passed;
        break;
      }
    }

    return this.assembleResult(request, roleOutcomes, extraMetadata, {
      internalGatePassed,
    });
  }

  private async runParallel(
    request: HarnessRunRequest,
  ): Promise<readonly RoleRunOutcome[]> {
    return Promise.all(
      this.options.definition.roles.map((role) => this.runRole(request, role)),
    );
  }

  private async runChain(
    request: HarnessRunRequest,
    execution: ChainExecution,
  ): Promise<readonly RoleRunOutcome[]> {
    const roles = resolveRoleOrder(this.options.definition, execution.order);
    const outcomes: RoleRunOutcome[] = [];
    const outputs: Record<string, string> = {};
    let previous = "";

    for (const role of roles) {
      const outcome = await this.runRole(request, role, {
        previous,
        outputs,
      });
      outcomes.push(outcome);
      if (outcome.outcome !== "completed") {
        // v1 thin default: abort at first failed/timed-out step.
        break;
      }
      previous = truncateRoleOutput(serializeRoleOutput(outcome));
      outputs[role.id] = previous;
    }
    return outcomes;
  }

  private async runValidationLoop(
    request: HarnessRunRequest,
    execution: ValidationLoopExecution,
  ): Promise<{
    readonly roleOutcomes: readonly RoleRunOutcome[];
    readonly rounds: number;
    readonly passed: boolean;
  }> {
    const implementationRoles = resolveRoleOrder(
      this.options.definition,
      execution.implementationRoles,
    );
    const validationRoles = resolveRoleOrder(
      this.options.definition,
      execution.validationRoles,
    );
    const passWhen =
      execution.passWhen ?? ((outcomes) => outcomes.length === 0);
    const maxRounds = Math.max(1, execution.maxRounds);

    let lastRound: RoleRunOutcome[] = [];
    let validationFeedback = "";
    let passed = false;
    let rounds = 0;

    for (let round = 1; round <= maxRounds; round += 1) {
      rounds = round;
      const implementationOutcomes = await Promise.all(
        implementationRoles.map((role) =>
          this.runRole(request, role, { validation: validationFeedback }),
        ),
      );
      const implementationOutput = truncateRoleOutput(
        implementationOutcomes.map(serializeRoleOutput).join("\n"),
      );
      const validationOutcomes = await Promise.all(
        validationRoles.map((role) =>
          this.runRole(request, role, { previous: implementationOutput }),
        ),
      );
      lastRound = [...implementationOutcomes, ...validationOutcomes];

      const anyFailure = lastRound.some(
        (outcome) => outcome.outcome !== "completed",
      );
      if (anyFailure) {
        break;
      }
      const validationHarnessOutcomes =
        validationOutcomes.flatMap(roleHarnessOutcomes);
      if (passWhen(validationHarnessOutcomes)) {
        passed = true;
        break;
      }
      validationFeedback = truncateRoleOutput(
        validationOutcomes.map(serializeRoleOutput).join("\n"),
      );
    }

    return { roleOutcomes: lastRound, rounds, passed };
  }

  private async assembleResult(
    request: HarnessRunRequest,
    outcomes: readonly RoleRunOutcome[],
    extraMetadata: Readonly<Record<string, string>>,
    gates: { readonly internalGatePassed?: boolean } = {},
  ): Promise<HarnessRunResult> {
    const findings = outcomes.flatMap((outcome) => outcome.findings);
    const artifacts = outcomes.flatMap((outcome) => outcome.artifacts);
    const timedOutRoles = outcomes
      .filter((outcome) => outcome.outcome === "timed_out")
      .map((outcome) => outcome.roleId);
    const failedRoles = outcomes
      .filter((outcome) => outcome.outcome === "failed")
      .map((outcome) => outcome.roleId);
    const completedRoles = outcomes
      .filter((outcome) => outcome.outcome === "completed")
      .map((outcome) => outcome.roleId);

    const metadata: Record<string, string> = {
      ...(request.metadata ?? {}),
      strict_mode: request.strictMode === true ? "true" : "false",
      timed_out_roles: timedOutRoles.join(","),
      failed_roles: failedRoles.join(","),
      completed_roles: completedRoles.join(","),
      ...extraMetadata,
    };

    // Generic outcomes are the opt-in surface for execution-configured
    // harnesses; legacy definitions keep the pre-generalization result
    // shape (and its serialized size) untouched.
    const isGeneralized = this.options.definition.execution !== undefined;
    const harnessOutcomes = outcomes.flatMap(roleHarnessOutcomes);
    const status = isGeneralized
      ? await this.generalizedStatus({
          findings,
          outcomes: harnessOutcomes,
          strictMode: request.strictMode === true,
          timedOutRoles,
          failedRoles,
          internalGatePassed: gates.internalGatePassed,
        })
      : statusFromOutcomes(findings, {
          strictMode: request.strictMode === true,
          timedOutRoles,
          failedRoles,
        });
    const result: HarnessRunResult = {
      runId: request.runId,
      status,
      findings,
      ...(isGeneralized ? { outcomes: harnessOutcomes } : {}),
      artifacts,
      metadata,
    };

    await writeJsonFile(
      join(request.scratchpadPath, "result.raw.json"),
      result,
    );
    return result;
  }

  /**
   * Run status for execution-configured harnesses. Findings and outcomes are
   * diagnostic payload and never drive status; role-execution problems and an
   * optional runtime pass gate do.
   */
  private async generalizedStatus(input: {
    readonly findings: readonly Finding[];
    readonly outcomes: readonly HarnessOutcome[];
    readonly strictMode: boolean;
    readonly timedOutRoles: readonly string[];
    readonly failedRoles: readonly string[];
    readonly internalGatePassed?: boolean;
  }): Promise<HarnessRunResult["status"]> {
    if (input.failedRoles.length > 0) {
      return "error";
    }
    if (input.strictMode && input.timedOutRoles.length > 0) {
      return "error";
    }
    // Internal convergence gate (validation-loop) fails the run regardless
    // of the external passGate.
    if (input.internalGatePassed === false) {
      return "failed";
    }
    if (this.options.passGate !== undefined) {
      const passed = await this.options.passGate({
        findings: input.findings,
        outcomes: input.outcomes,
      });
      if (!passed) {
        return "failed";
      }
    }
    if (input.timedOutRoles.length > 0) {
      return "warnings";
    }
    return "passed";
  }

  private async runRole(
    request: HarnessRunRequest,
    role: RoleDefinition,
    interpolation?: PromptInterpolationContext,
  ): Promise<RoleRunOutcome> {
    const roleScratchpadPath = join(request.scratchpadPath, "roles", role.id);
    await ensureDirectory(roleScratchpadPath);
    await this.options.onRoleStart?.(role.id);
    const prompt = interpolatePrompt(
      await readPrompt(role, this.options.embeddedPrompts),
      interpolation,
    );
    const findings: Finding[] = [];
    let outcome: "completed" | "timed_out" | "failed" = "completed";
    const env = this.options.roleEnv?.(role.id);

    const agentRequest: AgentRunRequest = {
      runId: request.runId,
      roleId: role.id,
      prompt,
      workspacePath: request.workspacePath,
      contextBundlePath:
        request.contextBundlePath ?? this.options.contextBundlePath,
      scratchpadPath: roleScratchpadPath,
      timeoutMs: role.timeoutMs,
      allowedCommands:
        role.allowedCommands ??
        this.options.definition.defaultAllowedCommands ??
        [],
      metadata: request.metadata,
      ...(env === undefined ? {} : { env }),
    };

    const genericOutcomes: HarnessOutcome[] = [];
    // Real subprocess agents emit the same envelope in an intermediate
    // assistant message AND the terminal result event, so the nested-text
    // scan captures it twice (#75). The outcome `id` is its identity:
    // first occurrence wins, per role run.
    const seenOutcomeIds = new Set<string>();
    for await (const event of this.options.adapter.run(agentRequest)) {
      await this.options.eventSink?.write(event);
      if (event.type === "finding" && isFinding(event.data)) {
        findings.push(event.data);
      }
      if (
        event.type === "outcome" &&
        isHarnessOutcome(event.data) &&
        !seenOutcomeIds.has(event.data.id)
      ) {
        seenOutcomeIds.add(event.data.id);
        genericOutcomes.push(event.data);
      }
      if (event.type === "error") {
        outcome = hasTimedOut(event.data) ? "timed_out" : "failed";
      }
    }

    return {
      roleId: role.id,
      findings,
      genericOutcomes,
      artifacts: [roleScratchpadPath],
      outcome,
    };
  }
}

function resolveRoleOrder(
  definition: HarnessDefinition,
  order: readonly string[] | undefined,
): readonly RoleDefinition[] {
  if (order === undefined) {
    return definition.roles;
  }
  return order.map((roleId) => {
    const role = definition.roles.find((candidate) => candidate.id === roleId);
    if (role === undefined) {
      throw new Error(
        `execution config references unknown role "${roleId}" in harness ${definition.id}`,
      );
    }
    return role;
  });
}

function roleHarnessOutcomes(outcome: RoleRunOutcome): HarnessOutcome[] {
  // The outcomes view is deduped by id (first wins): a stream-echoed
  // duplicate finding must not appear twice after conversion. Deliberately
  // NOT applied to result.findings itself — code-review reporting owns
  // finding dedup (canonical fingerprint), and its semantics differ.
  const seen = new Set<string>();
  const combined = [
    ...outcome.findings.map(findingToHarnessOutcome),
    ...outcome.genericOutcomes,
  ];
  return combined.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}

function serializeRoleOutput(outcome: RoleRunOutcome): string {
  return JSON.stringify(roleHarnessOutcomes(outcome), null, 2);
}

function interpolatePrompt(
  prompt: string,
  context: PromptInterpolationContext | undefined,
): string {
  if (context === undefined) {
    return prompt;
  }
  let interpolated = prompt;
  if (context.previous !== undefined) {
    interpolated = interpolated.replaceAll("{previous}", context.previous);
  }
  if (context.validation !== undefined) {
    interpolated = interpolated.replaceAll("{validation}", context.validation);
  }
  if (context.outputs !== undefined) {
    for (const [roleId, output] of Object.entries(context.outputs)) {
      interpolated = interpolated.replaceAll(`{outputs.${roleId}}`, output);
    }
  }
  return interpolated;
}

async function readPrompt(
  role: RoleDefinition,
  embeddedPrompts?: Readonly<Record<string, string>>,
): Promise<string> {
  if (role.prompt !== undefined) {
    return role.prompt;
  }
  const embeddedPrompt = embeddedPrompts?.[role.id];
  if (typeof embeddedPrompt === "string") {
    return embeddedPrompt;
  }
  if (role.promptPath !== undefined) {
    return readFile(role.promptPath, "utf8");
  }
  return role.description;
}

function statusFromFindings(
  findings: readonly Finding[],
): HarnessRunResult["status"] {
  if (findings.some((finding) => finding.severity === "critical")) {
    return "failed";
  }
  if (findings.length > 0) {
    return "warnings";
  }
  return "passed";
}

function statusFromOutcomes(
  findings: readonly Finding[],
  outcomes: {
    readonly strictMode: boolean;
    readonly timedOutRoles: readonly string[];
    readonly failedRoles: readonly string[];
  },
): HarnessRunResult["status"] {
  if (outcomes.failedRoles.length > 0) {
    return "error";
  }
  if (outcomes.strictMode && outcomes.timedOutRoles.length > 0) {
    return "error";
  }
  const findingStatus = statusFromFindings(findings);
  if (findingStatus === "failed") {
    return "failed";
  }
  if (findingStatus === "warnings" || outcomes.timedOutRoles.length > 0) {
    return "warnings";
  }
  return "passed";
}

function hasTimedOut(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { readonly reason?: unknown }).reason === "timed_out"
  );
}

function assertAdapterCapabilities(
  adapter: AgentAdapter,
  definition: HarnessDefinition,
): void {
  const capabilities = adapter.capabilities() as unknown as Readonly<
    Record<string, boolean>
  >;
  const missing = definition.roles.flatMap((role) =>
    role.requiredCapabilities
      .filter((capability) => capabilities[capability] !== true)
      .map((capability) => `${role.id}:${capability}`),
  );

  if (missing.length > 0) {
    throw new Error(
      `${adapter.name} adapter does not satisfy required capabilities: ${missing.join(", ")}`,
    );
  }
}
