export { type CreateFeedsOptions, createWorkFeeds } from "./create-feeds";
export type {
  WorkFeedClient,
  WorkFeedClientFactory,
  WorkFeedTerminalContext,
} from "./feed-client";
export { FakeWorkFeed } from "./feeds/fake";
export {
  GitHubIssuesFeed,
  type GitHubIssuesFeedOptions,
} from "./feeds/github-issues";
export {
  GitHubPrFeedbackFeed,
  type GitHubPrFeedbackFeedOptions,
  parsePrFeedbackIdentifier,
} from "./feeds/github-pr-feedback";
export {
  GitHubPrReviewFeed,
  type GitHubPrReviewFeedOptions,
} from "./feeds/github-pr-review";
export { McpTrackerFeed, type McpTrackerFeedConfig } from "./feeds/mcp-tracker";
export {
  emptyIngestDocument,
  ingestReasonForPull,
  threadActivityFingerprint,
} from "./feeds/pr-feedback-ingest-state";
export {
  type BlockerRef,
  type WorkItem,
  type WorkItemKind,
  workItemTemplateVars,
} from "./work-item";
