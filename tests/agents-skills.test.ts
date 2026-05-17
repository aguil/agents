import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { main as agentsMain } from "../packages/cli/src/index";

const REPO_ROOT = join(import.meta.dir, "..");
const MANIFEST_PATH = join(REPO_ROOT, "docs/skills/skills.json");
const DOC_SKILL = join(REPO_ROOT, "docs/skills/review-fix-loop/SKILL.md");

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

test("agents skills list exits 0 and prints review-fix-loop", async () => {
  const prev = console.log;
  let buf = "";
  console.log = (...args: unknown[]) => {
    buf += `${args.join(" ")}\n`;
  };
  try {
    const code = await agentsMain(["skills", "list"]);
    expect(code).toBe(0);
    expect(buf).toContain("review-fix-loop");
    expect(buf).toContain("minAgentsVersion");
  } finally {
    console.log = prev;
  }
});

test("agents --version prints root package version", async () => {
  const prev = console.log;
  let line = "";
  console.log = (...args: unknown[]) => {
    line = String(args[0] ?? "");
  };
  try {
    const code = await agentsMain(["--version"]);
    expect(code).toBe(0);
    expect(line).toMatch(/^\d+\.\d+\.\d+/u);
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
    expect(out).toContain("review-fix-loop");
  } finally {
    console.log = prevLog;
    console.error = prevErr;
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
