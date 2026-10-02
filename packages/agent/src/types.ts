import type { ModelMessage, ModelToolCall } from '@kaizen-harness/model';

export interface AgentState {
  conversation: ModelMessage[];
  context: Record<string, any>;
  step: number;
}

export interface AgentConfig {
  maxSteps: number;
  temperature: number;
  model: string;
}

export type AgentDecision =
  | {
      action: 'tool_calls';
      reasoning: string;
      toolCalls: ModelToolCall[];
    }
  | {
      action: 'finish';
      reasoning: string;
      summary: string;
    }
  | {
      action: 'max_steps';
      reasoning: string;
    }
  | {
      action: 'error';
      reasoning: string;
    };

export interface DecideOptions {
  /** Cancels the model request, including a partially consumed stream. */
  signal?: AbortSignal;
}

/**
 * One reasoning step in flight. `text` deltas arrive as the model produces them;
 * a `decision` always terminates the step.
 */
export type AgentStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'decision'; decision: AgentDecision };
