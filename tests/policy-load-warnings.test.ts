import { expect, test } from "bun:test";
import type { PolicySpec } from "@aguil/agents-harness-config";
import {
  allowEntryRunsAnything,
  policyLoadWarnings,
} from "@aguil/agents-policy";

/** ADR 0026 decision 6: an allowlisted interpreter or runner warns (JC-4). */

test("each interpreter warns when nothing after it names what runs", () => {
  for (const program of [
    "sh",
    "bash",
    "zsh",
    "python",
    "python3",
    "node",
    "bun",
    "deno",
    "perl",
    "ruby",
    "git",
  ]) {
    expect(allowEntryRunsAnything(program)).toBe(true);
    expect(allowEntryRunsAnything(`${program} -c`)).toBe(true);
  }
  for (const entry of [
    "git -C",
    "git -C /tmp",
    "git -c",
    "python3 -W ignore",
    "python3 -m pytest",
    "node -e",
    "bun -e",
    "/bin/bash",
  ]) {
    expect(allowEntryRunsAnything(entry)).toBe(true);
  }
});

test("each command runner warns whatever follows it", () => {
  for (const entry of [
    "env",
    "env FOO=1",
    "xargs",
    "xargs rg",
    "sudo",
    "find",
    "find . -name x",
  ]) {
    expect(allowEntryRunsAnything(entry)).toBe(true);
  }
});

test("an entry that names what runs loads without a warning (JC-18)", () => {
  for (const entry of [
    "bun test",
    "git log",
    "git -C /tmp log",
    "bash script.sh",
    "python3 -m pytest tests",
    "rg",
    "cat",
    "jj log",
  ]) {
    expect(allowEntryRunsAnything(entry)).toBe(false);
  }
});

test("the warning names the policy, the entry and the deny rules it voids (JC-6)", () => {
  const policy: PolicySpec = {
    id: "probes",
    capabilities: {
      exec: { allow: ["rg", "sh", "git -C /tmp"], deny: ["rm", "git push"] },
      filesystem: { deny: [".env"] },
    },
  };
  expect(policyLoadWarnings(policy)).toEqual([
    "policy probes: exec.allow entry `sh` can run any command behind it, so these deny rules do not hold for it: exec.deny `rm`, `git push`; filesystem.deny `.env` for reads (ADR 0026)",
    "policy probes: exec.allow entry `git -C /tmp` can run any command behind it, so these deny rules do not hold for it: exec.deny `rm`, `git push`; filesystem.deny `.env` for reads (ADR 0026)",
  ]);
  expect(
    policyLoadWarnings({
      id: "bare",
      capabilities: { exec: { allow: ["env"] } },
    }),
  ).toEqual([
    "policy bare: exec.allow entry `env` can run any command behind it, so no deny rule added to this policy would hold for it (ADR 0026)",
  ]);
  expect(
    policyLoadWarnings({
      id: "plain",
      capabilities: { exec: { allow: ["bun test", "rg"], deny: ["rm"] } },
    }),
  ).toEqual([]);
});
