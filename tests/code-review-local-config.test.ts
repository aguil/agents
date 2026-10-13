import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT } from "@aguil/agents-code-review";
import { AGENTS_CODE_REVIEW_DIR } from "@aguil/agents-core";
import {
  resolveCodeReviewCliOptions,
  resolveLocalCodeReviewConfigPath,
} from "../packages/cli/src/code-review-config";
import { parseCodeReviewArgv } from "../packages/cli/src/parse-code-review-argv";

/**
 * #179: `<workspace>/.agents-code-review/config.local.json` overrides the repo
 * config in one checkout. It merges after the repo layer and before
 * `--preset`, and gets the repo filter (JC-7, JC-8).
 */

let tempRoot: string;
let ws: string;
let prevXdg: string | undefined;
let prevModelEnv: string | undefined;
let warns: string[];
const origWarn = console.warn;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "agents-cr-local-cfg-"));
  ws = join(tempRoot, "ws");
  const xdg = join(tempRoot, "xdg");
  await mkdir(join(xdg, "agents", "code-review"), { recursive: true });
  await mkdir(join(ws, AGENTS_CODE_REVIEW_DIR), { recursive: true });
  prevXdg = process.env.XDG_CONFIG_HOME;
  prevModelEnv = process.env.AGENTS_CODE_REVIEW_MODEL;
  process.env.XDG_CONFIG_HOME = xdg;
  delete process.env.AGENTS_CODE_REVIEW_MODEL;
  warns = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.warn = origWarn;
  await rm(tempRoot, { recursive: true, force: true });
  if (prevXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = prevXdg;
  }
  if (prevModelEnv === undefined) {
    delete process.env.AGENTS_CODE_REVIEW_MODEL;
  } else {
    process.env.AGENTS_CODE_REVIEW_MODEL = prevModelEnv;
  }
});

async function writeUser(doc: unknown): Promise<void> {
  await writeFile(
    join(tempRoot, "xdg", "agents", "code-review", "config.json"),
    JSON.stringify(doc),
  );
}

async function writeRepo(doc: unknown): Promise<void> {
  await writeFile(
    join(ws, AGENTS_CODE_REVIEW_DIR, "config.json"),
    JSON.stringify(doc),
  );
}

async function writeLocal(doc: unknown): Promise<void> {
  await writeFile(resolveLocalCodeReviewConfigPath(ws), JSON.stringify(doc));
}

async function resolveWith(argv: readonly string[]) {
  const r = await resolveCodeReviewCliOptions(ws, parseCodeReviewArgv(argv));
  if (!r.ok) {
    throw new Error(r.error);
  }
  return r.options;
}

test("the local file sits beside the repo config", () => {
  expect(resolveLocalCodeReviewConfigPath(ws)).toBe(
    join(ws, AGENTS_CODE_REVIEW_DIR, "config.local.json"),
  );
});

test("a local model overrides a repo model, which overrides a user model", async () => {
  await writeUser({ model: "from-user", variant: "user-variant" });
  await writeRepo({ model: "from-repo", reviewSummary: "triage" });
  await writeLocal({ model: "from-local" });

  const options = await resolveWith([]);
  expect(options.model).toBe("from-local");
  // Keys the local file leaves alone keep their lower layers.
  expect(options.reviewSummary).toBe("triage");
  expect(options.variant).toBe("user-variant");
  expect(warns).toEqual([]);
});

test("a local adapter or host-binary path is stripped with the repo-managed warning naming the local file", async () => {
  await writeUser({ cursor: "/user/agent" });
  await writeLocal({
    adapter: "cursor",
    cursor: "/local/agent",
    model: "from-local",
    presets: { ci: { claude: "/local/claude", dryRun: true } },
  });

  const options = await resolveWith([]);
  expect(options.adapter).toBe(CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT);
  expect(options.cursor).toBe("/user/agent");
  expect(options.model).toBe("from-local");

  const localPath = resolveLocalCodeReviewConfigPath(ws);
  const warning = warns.find((line) =>
    line.startsWith(`${localPath}: ignoring repo-managed review overrides`),
  );
  expect(warning).toBeDefined();
  expect(warning).toContain("adapter, cursor, preset:ci.claude");

  const withPreset = await resolveWith(["--preset", "ci"]);
  expect(withPreset.claude).toBeUndefined();
  expect(withPreset.dryRun).toBe(true);
});

test("a local preset body overrides the repo's preset of the same name for the keys it sets", async () => {
  await writeUser({ presets: { ci: { variant: "user-variant" } } });
  await writeRepo({
    presets: {
      ci: { model: "repo-ci-model", reviewSummary: "evidence" },
      nightly: { model: "repo-nightly" },
    },
  });
  await writeLocal({ presets: { ci: { model: "local-ci-model" } } });

  const ci = await resolveWith(["--preset", "ci"]);
  expect(ci.model).toBe("local-ci-model");
  expect(ci.reviewSummary).toBe("evidence");
  expect(ci.variant).toBe("user-variant");

  const nightly = await resolveWith(["--preset", "nightly"]);
  expect(nightly.model).toBe("repo-nightly");
});

test("a preset defined only in the local file can be selected", async () => {
  await writeLocal({ presets: { mine: { model: "local-only" } } });

  const options = await resolveWith(["--preset", "mine"]);
  expect(options.model).toBe("local-only");
});

test("--preset, env and CLI still override the local layer", async () => {
  await writeRepo({ presets: { ci: { model: "repo-preset-model" } } });
  await writeLocal({ model: "from-local" });

  expect((await resolveWith(["--preset", "ci"])).model).toBe(
    "repo-preset-model",
  );

  process.env.AGENTS_CODE_REVIEW_MODEL = "from-env";
  expect((await resolveWith([])).model).toBe("from-env");

  expect((await resolveWith(["--model", "from-cli"])).model).toBe("from-cli");
});

test("with no local file the merge is unchanged and silent", async () => {
  await writeUser({ model: "from-user" });
  await writeRepo({ model: "from-repo" });

  const options = await resolveWith([]);
  expect(options.model).toBe("from-repo");
  expect(warns).toEqual([]);
});

test("an unreadable local file fails the run, naming the file", async () => {
  await writeFile(resolveLocalCodeReviewConfigPath(ws), "{ not json");

  const r = await resolveCodeReviewCliOptions(ws, parseCodeReviewArgv([]));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error.startsWith(resolveLocalCodeReviewConfigPath(ws))).toBe(true);
  }
});
