import { watch } from "node:fs";
import { loadWorkflowFile } from "./load-workflow";
import type { WorkflowDefinition } from "./types";

export interface WorkflowWatchHandle {
  close(): void;
}

export function watchWorkflowFile(
  workflowPath: string,
  onReload: (
    definition: WorkflowDefinition | undefined,
    error?: string,
  ) => void,
): WorkflowWatchHandle {
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const reload = async (): Promise<void> => {
    const result = await loadWorkflowFile(workflowPath);
    if (result.error !== undefined) {
      onReload(undefined, `${result.error.code}: ${result.error.message}`);
      return;
    }
    onReload(result.definition);
  };

  const watcher = watch(workflowPath, () => {
    if (debounce !== undefined) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      void reload();
    }, 200);
  });

  return {
    close() {
      watcher.close();
      if (debounce !== undefined) {
        clearTimeout(debounce);
      }
    },
  };
}
