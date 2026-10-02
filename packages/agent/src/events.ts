import type { ToolResult } from '@kaizen-harness/tools';

/**
 * Structured output from an agent run.
 *
 * The agent never writes to stdout. Consumers (the CLI, a test, another harness)
 * subscribe to these events and decide how to present them. This keeps the core
 * free of terminal concerns and makes a run fully observable without scraping logs.
 */
export type AgentEvent =
  | { type: 'thinking'; step: number }
  | { type: 'tool_start'; tool: string; input: unknown }
  | { type: 'tool_result'; tool: string; result: ToolResult }
  | { type: 'text_delta'; content: string }
  | { type: 'text'; content: string }
  | { type: 'error'; error: Error }
  | { type: 'done'; answer: string; steps: number };

export type EventSink = (event: AgentEvent) => void;

/** Collects events into an array. Useful in tests and for post-run inspection. */
export function createEventLog(): { events: AgentEvent[]; sink: EventSink } {
  const events: AgentEvent[] = [];
  return { events, sink: event => void events.push(event) };
}