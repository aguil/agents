import { findingFingerprint } from "@aguil/agents-reporting";
import { resolveGitAwarePath } from "@aguil/agents-core";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type ResultJson = {
  readonly findings?: unknown;
  readonly metadata?: Record<string, string>;
  readonly [key: string]: unknown;
};

type Finding = {
  readonly id: string;
  readonly severity: "critical" | "warning" | "unknown";
  readonly title: string;
  readonly description: string;
  readonly evidence: string;
  readonly sourceRole: string;
  readonly file?: string;
  readonly line?: number;
  readonly validation: { readonly status: string; readonly details: string };
};

async function runGhJson<T>(args: readonly string[], cwd: string): Promise<T> {
  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const proc = Bun.spawn({ cmd: ["gh", ...args], cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode === 0) {
      return JSON.parse(stdout) as T;
    }
    const message = stderr.trim() || `exit code ${exitCode}`;
    const isTransientNetwork =
      /error connecting to api\.github\.com/i.test(message) ||
      /\bTLS handshake timeout\b/i.test(message) ||
      /\btimeout\b/i.test(message) ||
      /\btemporarily unavailable\b/i.test(message) ||
      /\bconnection reset\b/i.test(message) ||
      /\bconnection refused\b/i.test(message) ||
      /\bEOF\b/i.test(message) ||
      /\bno such host\b/i.test(message) ||
      /\bnetwork is unreachable\b/i.test(message);
    if (!isTransientNetwork || attempt === attempts) {
      throw new Error(`gh ${args.join(" ")} failed: ${message}`);
    }
    const backoffMs = 250 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
    await Bun.sleep(backoffMs);
  }
  throw new Error(`gh ${args.join(" ")} failed: exhausted retries`);
}

async function fetchResolvedFindingMarkers(input: {
  readonly repo: string;
  readonly prNumber: number;
  readonly allowedAuthor: string;
  readonly cwd: string;
}): Promise<ReadonlySet<string>> {
  const [owner, name] = input.repo.split("/");
  if (!owner || !name) {
    return new Set();
  }
  const marker = /<!--\s*finding:([^>]+?)\s*-->/g;
  const resolved = new Set<string>();

  const query = [
    "query($o:String!,$r:String!,$n:Int!,$after:String){",
    "repository(owner:$o,name:$r){",
    "pullRequest(number:$n){",
    "reviewThreads(first:100,after:$after){",
    "pageInfo{hasNextPage endCursor}",
    "nodes{isResolved comments(first:50){nodes{body author{login}}}}",
    "}",
    "}",
    "}",
    "}",
  ].join("");

  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const resp = await runGhJson<{
      readonly data?: {
        readonly repository?: {
          readonly pullRequest?: {
            readonly reviewThreads?: {
              readonly pageInfo?: { readonly hasNextPage?: boolean; readonly endCursor?: string | null };
              readonly nodes?: ReadonlyArray<{
                readonly isResolved?: boolean;
                readonly comments?: { readonly nodes?: ReadonlyArray<{ readonly body?: string; readonly author?: { readonly login?: string } }> };
              }>;
            };
          };
        };
      };
    }>([
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `o=${owner}`,
      "-f",
      `r=${name}`,
      "-F",
      `n=${input.prNumber}`,
      ...(after !== undefined ? ["-f", `after=${after}`] : []),
    ], input.cwd);

    for (const thread of resp.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
      if (thread.isResolved !== true) {
        continue;
      }
      for (const comment of thread.comments?.nodes ?? []) {
        const body = comment.body;
        if (typeof body !== "string") {
          continue;
        }
        const author = comment.author?.login;
        if (author !== input.allowedAuthor) {
          continue;
        }
        for (const match of body.matchAll(marker)) {
          const fp = match[1]?.trim();
          if (fp) {
            resolved.add(fp);
          }
        }
      }
    }

    const pageInfo = resp.data?.repository?.pullRequest?.reviewThreads?.pageInfo;
    if (pageInfo?.hasNextPage !== true) {
      break;
    }
    const endCursor = pageInfo.endCursor ?? undefined;
    if (!endCursor) {
      break;
    }
    after = endCursor;
  }

  return resolved;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const runsRoot = resolve(cwd, ".review-agent", "runs");
  const gitAware = (await resolveGitAwarePath(cwd)).gitAwarePath;

  const repo = (await runGhJson<{ readonly nameWithOwner: string }>(["repo", "view", "--json", "nameWithOwner"], gitAware))
    .nameWithOwner;
  const login = (await runGhJson<{ readonly login: string }>(["api", "user"], gitAware)).login;
  const prNumber = 6;

  const resolvedMarkers = await fetchResolvedFindingMarkers({
    repo,
    prNumber,
    allowedAuthor: login,
    cwd: gitAware,
  });

  const entries = await readdir(runsRoot);
  const resultPaths = entries
    .filter((entry) => entry.startsWith("code-review-"))
    .map((entry) => join(runsRoot, entry, "result.json"));

  let updated = 0;
  for (const resultPath of resultPaths) {
    let parsed: ResultJson;
    try {
      parsed = JSON.parse(await readFile(resultPath, "utf8")) as ResultJson;
    } catch {
      continue;
    }
    const metadata = parsed.metadata ?? {};
    if (metadata.pr_number !== String(prNumber)) {
      continue;
    }
    if (!Array.isArray(parsed.findings)) {
      continue;
    }
    const findings = parsed.findings as Finding[];
    const resolvedFingerprints = findings
      .map((finding) => findingFingerprint(finding as unknown as any))
      .filter((fp) => resolvedMarkers.has(fp));

    const nextMetadata = {
      ...metadata,
      pr_resolved_finding_fingerprints: resolvedFingerprints.join(","),
      pr_resolved_findings_count: String(resolvedFingerprints.length),
      pr_resolved_evaluated_at: new Date().toISOString(),
    };

    await writeFile(resultPath, `${JSON.stringify({ ...parsed, metadata: nextMetadata }, null, 2)}\n`, "utf8");
    updated += 1;
  }

  console.log(`Updated ${updated} run result(s) for PR #${prNumber}.`);
}

await main();

