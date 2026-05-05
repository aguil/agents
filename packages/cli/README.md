# CLI

Command-line entrypoints for running harnesses locally and in automation.

When `--workspace` points at a jj workspace (with `.jj/repo` and no `.git`), the CLI auto-resolves the canonical colocated repo for git/gh commands while keeping file artifacts in the workspace.
