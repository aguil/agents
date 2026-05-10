import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentEvent } from "@aguil/agents-core";
import { ensureDirectory } from "@aguil/agents-core";

export interface EventSink {
  write(event: AgentEvent): void | Promise<void>;
}

export function serializeEvent(event: AgentEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export class JsonlFileEventSink implements EventSink {
  constructor(private readonly path: string) {}

  async write(event: AgentEvent): Promise<void> {
    await ensureDirectory(dirname(this.path));
    await appendFile(this.path, serializeEvent(event), "utf8");
  }
}
