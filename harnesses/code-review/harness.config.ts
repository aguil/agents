import { codeReviewHarnessDefinition } from "./src/index";
import { CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT } from "./src/harness-package-defaults";

export default {
  harness: codeReviewHarnessDefinition.id,
  orchestrator: "native-bun",
  executionAdapter: CODE_REVIEW_HARNESS_PACKAGE_ADAPTER_DEFAULT,
  roles: codeReviewHarnessDefinition.roles.map((role) => role.id),
};
