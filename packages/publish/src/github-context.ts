import { runGhJson } from "@aguil/agents-github";

interface GhViewer {
  readonly login: string;
}

interface GhReview {
  readonly state: string;
  readonly user: { readonly login: string };
}

export async function fetchPullRequestHeadSha(input: {
  readonly workspacePath: string;
  readonly repository: string;
  readonly pullNumber: number;
}): Promise<string | undefined> {
  const row = await runGhJson<{ readonly headRefOid?: string }>(
    [
      "pr",
      "view",
      String(input.pullNumber),
      "--repo",
      input.repository,
      "--json",
      "headRefOid",
    ],
    input.workspacePath,
  );
  const sha = row?.headRefOid?.trim();
  return sha !== undefined && sha.length > 0 ? sha : undefined;
}

export async function viewerHasPendingPullRequestReview(input: {
  readonly workspacePath: string;
  readonly repository: string;
  readonly pullNumber: number;
}): Promise<boolean> {
  const viewer = await runGhJson<GhViewer>(
    ["api", "user"],
    input.workspacePath,
  );
  const login = viewer?.login?.trim() ?? "";
  if (login.length === 0) {
    return false;
  }

  const reviews = await runGhJson<readonly GhReview[]>(
    ["api", `repos/${input.repository}/pulls/${input.pullNumber}/reviews`],
    input.workspacePath,
  );
  if (!Array.isArray(reviews)) {
    return false;
  }
  return reviews.some(
    (review) => review.state === "PENDING" && review.user.login === login,
  );
}
