import type { AgentEvent } from "@aguil/agents-core";

export interface EventSink {
  write(event: AgentEvent): void | Promise<void>;
}

export function serializeEvent(event: AgentEvent): string {
  return `${JSON.stringify(event)}\n`;
}
