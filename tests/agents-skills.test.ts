import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as agentsMain } from "../packages/cli/src/index";

const REPO_ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(REPO_ROOT, "docs/skills/skills.json");
const DOC_SKILL = join(REPO_ROOT, "docs/skills/self-review-checks/SKILL.md");

test("skills manifest paths exist on disk", async () => {
  const raw = await readFile(MANIFEST_PATH, "utf8");
  const manifest = JSON.parse(raw) as {
    readonly skills: readonly { readonly path: string }[];
  };
  for (const s of manifest.skills) {
    const p = join(REPO_ROOT, "docs/skills", s.path);
    expect(existsSync(p)).toBe(true);
  }
  expect(existsSync(DOC_SKILL)).toBe(true);
});

test("agents skills list exits 0 and prints self-review-checks", async () => {
  const prev = console.log;
  let buf = "";
  console.log = (...args: unknown[]) => {
    buf += `${args.join(" ")}\n`;
  };
  try {
    const code = await agentsMain(["skills", "list"]);
    expect(code).toBe(0);
    expect(buf).toContain("self-review-checks");
    expect(buf).toContain('"id": "code-review"');
    expect(buf).toContain('"id": "pr-feedback-response"');
    expect(buf).toContain("minAgentsVersion");
  } finally {
    console.log = prev;
  }
});

test("agents --version prints root package version", async () => {
  const rootPkg = JSON.parse(
    await readFile(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { version?: string };
  const prev = console.log;
  let line = "";
  console.log = (...args: unknown[]) => {
    line = String(args[0] ?? "");
  };
  try {
    const code = await agentsMain(["--version"]);
    expect(code).toBe(0);
    expect(line).toBe(rootPkg.version ?? "0.0.0");
  } finally {
    console.log = prev;
  }
});

test("agents triage --help documents --from", async () => {
  const prev = console.log;
  let help = "";
  console.log = (...args: unknown[]) => {
    help += `${args.join("\n")}\n`;
  };
  try {
    const code = await agentsMain(["triage", "--help"]);
    expect(code).toBe(0);
    expect(help).toContain("--from");
    expect(help).toContain("code-review");
    expect(help).toContain("pr-feedback");
  } finally {
    console.log = prev;
  }
});

test("agents doctor exits 0 in this monorepo", async () => {
  const prevLog = console.log;
  const prevErr = console.error;
  let out = "";
  console.log = (...args: unknown[]) => {
    out += `${args.join(" ")}\n`;
  };
  console.error = () => {};
  try {
    const code = await agentsMain(["doctor"]);
    expect(code).toBe(0);
    expect(out).toContain("self-review-checks");
    expect(out).toContain("pr-feedback-response");
  } finally {
    console.log = prevLog;
    console.error = prevErr;
  }
});

test("agents skills install --dry-run without id installs all manifest skills", async () => {
  const prev = console.log;
  let buf = "";
  console.log = (...args: unknown[]) => {
    buf += `${args.join(" ")}\n`;
  };
  try {
    const code = await agentsMain(["skills", "install", "--dry-run"]);
    expect(code).toBe(0);
    expect(buf).toContain("# Skill: self-review-checks");
    expect(buf).toContain("# Skill: pr-feedback-response");
    expect(buf).toContain("(dry-run: no files written)");
  } finally {
    console.log = prev;
  }
});

test("agents skills doctor points to agents doctor", async () => {
  const prevErr = console.error;
  let err = "";
  console.error = (...args: unknown[]) => {
    err += `${args.join(" ")}\n`;
  };
  try {
    const code = await agentsMain(["skills", "doctor"]);
    expect(code).toBe(1);
    expect(err).toContain("agents doctor");
  } finally {
    console.error = prevErr;
  }
});

/** Collapse Markdown line wrapping so phrases can be matched across lines. */
function flatten(markdown: string): string {
  return markdown.replace(/\s+/g, " ");
}

test("self-review-checks puts the criteria file with the code-review artifacts", async () => {
  const doc = flatten(await readFile(DOC_SKILL, "utf8"));
  expect(doc).toContain(
    "under the workspace's `.agents-code-review/criteria/` directory",
  );
  expect(doc).not.toContain("keep it with the plan");
  expect(doc).toContain(
    "Suggest that line only for criteria committed in the repository or reachable by a URL on the same host and owner as the tracked remote.",
  );
  expect(doc).toContain(
    "The criteria file's path (the local `.agents-code-review/criteria/` path,",
  );
});

test("agents skills install self-review-checks copies the current SKILL.md", async () => {
  const home = await mkdtemp(join(tmpdir(), "agents-skills-home-"));
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        join(REPO_ROOT, "packages/cli/src/index.ts"),
        "skills",
        "install",
        "self-review-checks",
      ],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(0);
    const installed = await readFile(
      join(home, ".agents/skills/self-review-checks/SKILL.md"),
      "utf8",
    );
    expect(installed).toBe(await readFile(DOC_SKILL, "utf8"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
