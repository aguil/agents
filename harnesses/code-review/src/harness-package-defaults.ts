/**
 * Default execution adapter for this harness. Single source for `harness.config.ts`
 * and the CLI’s lowest-precedence merge layer (`user/repo` config and env override this).
 */
export const CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT = "fake" as const;

/** Partial CLI-shaped defaults merged below user + repo JSON in `resolveCodeReviewCliOptions`. */
export const codeReviewHarnessPackageCliDefaults = {
  adapter: CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT,
} as const satisfies Readonly<{
  readonly adapter: typeof CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT;
}>;
