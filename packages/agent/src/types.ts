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
      action: 'respond';
      reasoning: string;
      message: string;
    }
  | {
      action: 'max_steps';
      reasoning: string;
    }
  | {
      action: 'error';
      reasoning: string;
    };