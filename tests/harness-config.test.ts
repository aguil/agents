import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarness, loadManifest } from "@aguil/agents-harness-config";

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "agents-dir",
);

test("loadHarness maps harness.yaml to orchestration types", async () => {
  const loaded = await loadHarness({
    agentsDir: fixturesDir,
    harnessId: "triage-demo",
  });

  expect(loaded.definition.id).toBe("triage-demo");
  expect(loaded.definition.roles.map((r) => r.id)).toEqual([
    "scout",
    "diagnose",
  ]);

  const scout = loaded.definition.roles[0];
  expect(scout.prompt).toContain("Investigate the alert log");
  expect(scout.timeoutMs).toBe(300_000);
  expect(scout.requiredCapabilities).toEqual([]);

  const diagnose = loaded.definition.roles[1];
  expect(diagnose.prompt).toBeUndefined();
  expect(diagnose.promptPath).toBe(
    join(fixturesDir, "harnesses", "triage-demo", "prompts", "diagnose.md"),
  );
  expect(diagnose.allowedCommands).toEqual(["bun test"]);

  expect(loaded.definition.execution).toEqual({
    mode: "chain",
    order: ["scout", "diagnose"],
  });
});

test("loadHarness resolves the referenced policy", async () => {
  const loaded = await loadHarness({
    agentsDir: fixturesDir,
    harnessId: "triage-demo",
  });
  expect(loaded.policy?.id).toBe("triage-readonly");
  expect(loaded.policy?.capabilities?.exec?.deny).toEqual(["rm", "git push"]);
  expect(loaded.policy?.capabilities?.network?.deny).toEqual(["*"]);
  expect(loaded.policy?.limits?.costUsd).toBe(2.5);
  expect(loaded.policy?.limits?.timeoutMs).toBe(600_000);
  expect(loaded.policy?.confirmations?.requiredFor).toEqual(["exec.unknown"]);
});

test("loadManifest reads enabled harnesses and tolerates a missing file", async () => {
  const manifest = await loadManifest(fixturesDir);
  expect(manifest.specVersion).toBe("0.1");
  expect(manifest.enabledHarnesses).toEqual(["triage-demo"]);

  const empty = await loadManifest(join(fixturesDir, "no-such-dir"));
  expect(empty.enabledHarnesses).toEqual([]);
});

test("loadHarness rejects missing files, bad versions, and bad role refs", async () => {
  await expect(
    loadHarness({ agentsDir: fixturesDir, harnessId: "nope" }),
  ).rejects.toThrow('harness "nope" not readable');

  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "bad");
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "9.9"',
        "kind: harness",
        "harness: { id: bad }",
        "roles: { a: { description: A } }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "bad" }),
    ).rejects.toThrow('unsupported spec_version "9.9"');

    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: bad }",
        "roles: { a: { description: A } }",
        "execution: { mode: chain, order: [a, ghost] }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "bad" }),
    ).rejects.toThrow('references unknown role "ghost"');

    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: mismatched }",
        "roles: { a: { description: A } }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "bad" }),
    ).rejects.toThrow('does not match directory "bad"');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("loadHarness rejects validation-loop configs with missing role lists", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const scratch = await mkdtemp(join(tmpdir(), "harness-config-"));
  try {
    const dir = join(scratch, "harnesses", "loop");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "harness.yaml"),
      [
        'spec_version: "0.1"',
        "kind: harness",
        "harness: { id: loop }",
        "roles: { w: { description: W }, v: { description: V } }",
        "execution: { mode: validation-loop, implementation_roles: [w] }",
      ].join("\n"),
    );
    await expect(
      loadHarness({ agentsDir: scratch, harnessId: "loop" }),
    ).rejects.toThrow("execution.validation_roles must list at least one role");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
