/**
 * `agents doctor` — verify `agents --version` satisfies each bundled skill's minAgentsVersion.
 */
import {
  loadSkillsManifest,
  type SkillsManifest,
  tryMonorepoCliArgv,
} from "./skills-pack";

export type DoctorHelpRequest =
  | { readonly kind: "overview" }
  | { readonly kind: "overview"; readonly unknownSubcommand: string };

function stripHelpTokens(argv: readonly string[]): readonly string[] {
  return argv.filter((t) => t !== "--help" && t !== "-h");
}

/** Resolve when user ran `agents doctor … --help`. */
export function resolveDoctorHelp(
  argv: readonly string[],
): DoctorHelpRequest | null {
  if (argv.length === 0 || !argv.some((t) => t === "--help" || t === "-h")) {
    return null;
  }
  const rest = [...stripHelpTokens(argv)];
  if (rest[0] !== "doctor") {
    return null;
  }
  const after = rest.slice(1);
  if (after.length === 0 || after[0].startsWith("--")) {
    return { kind: "overview" };
  }
  return { kind: "overview", unknownSubcommand: after[0] };
}

export function renderDoctorHelp(req: DoctorHelpRequest): string {
  const bad =
    "unknownSubcommand" in req && req.unknownSubcommand !== undefined
      ? `Note: unknown argument '${req.unknownSubcommand}' (stderr has details).\n\n`
      : "";
  return `${bad}Usage: agents doctor

Verify the running agents CLI semver against each entry in docs/skills/skills.json
(minAgentsVersion).

Environment:
  AGENTS_CLI           Path to agents launcher for version probe (optional; default: PATH lookup)

See also: agents skills --help (list / install playbooks)
`;
}

export function doctorHelpStderrExtras(
  req: DoctorHelpRequest,
): readonly string[] {
  if ("unknownSubcommand" in req && req.unknownSubcommand !== undefined) {
    return [
      `Unexpected argument '${req.unknownSubcommand}'.`,
      "`agents doctor` takes no positional arguments — see 'agents doctor --help'.",
    ];
  }
  return [];
}

function parseSemverPrefix(v: string): readonly [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(v.trim());
  if (m === null) {
    return [0, 0, 0];
  }
  return [
    Number.parseInt(m[1] ?? "0", 10),
    Number.parseInt(m[2] ?? "0", 10),
    Number.parseInt(m[3] ?? "0", 10),
  ];
}

function semverGte(candidate: string, minimum: string): boolean {
  const a = parseSemverPrefix(candidate);
  const b = parseSemverPrefix(minimum);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] > b[i];
    }
  }
  return true;
}

function resolveAgentsExecutable(): string | null {
  const fromEnv = process.env.AGENTS_CLI?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return Bun.which("agents");
}

async function runAgentsVersionArgv(
  argv: readonly string[],
): Promise<string | null> {
  const proc = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    return null;
  }
  const out = await new Response(proc.stdout).text();
  const line = out.trim().split(/\r?\n/u)[0]?.trim();
  return line ?? null;
}

export async function runAgentsDoctor(
  manifest?: SkillsManifest,
): Promise<number> {
  const m = manifest ?? (await loadSkillsManifest());
  const exe = resolveAgentsExecutable();
  const mono = tryMonorepoCliArgv();
  let versionArgv: readonly string[];
  let label: string;
  if (exe !== null) {
    versionArgv = [exe, "--version"];
    label = exe;
  } else if (mono !== null) {
    versionArgv = [...mono, "--version"];
    label = versionArgv.join(" ");
  } else {
    console.error(
      "Could not find `agents` on PATH. Install `@aguil/agents` globally or set AGENTS_CLI to your launcher.",
    );
    return 1;
  }
  const ver = await runAgentsVersionArgv(versionArgv);
  if (ver === null) {
    console.error(`Could not read version from: ${label}`);
    return 1;
  }
  console.log(`agents: ${label}`);
  console.log(`version: ${ver}`);
  let ok = true;
  for (const s of m.skills) {
    const pass = semverGte(ver, s.minAgentsVersion);
    if (!pass) {
      ok = false;
    }
    console.log(
      `${pass ? "ok" : "FAIL"}  skill=${s.id}  need>=${s.minAgentsVersion}`,
    );
  }
  return ok ? 0 : 1;
}
