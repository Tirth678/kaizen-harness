export interface ModelToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ModelToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string; name: string };

export interface ModelResponse {
  content: string;
  toolCalls?: ModelToolCall[] | undefined;
  finishReason?: string | undefined;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
  }>;
}

export interface ModelProvider {
  generate(messages: ModelMessage[], tools?: ToolDefinition[]): Promise<ModelResponse>;
  supportsTools(): boolean;
}