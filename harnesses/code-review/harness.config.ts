import { codeReviewHarnessDefinition } from "./src/index";

export default {
  harness: codeReviewHarnessDefinition.id,
  orchestrator: "native-bun",
  executionAdapter: "fake",
  roles: codeReviewHarnessDefinition.roles.map((role) => role.id),
};
