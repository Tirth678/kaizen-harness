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
  generate(messages: ModelMessage[], tools?: ToolDefinition[], options?: GenerateOptions): Promise<ModelResponse>;
  /**
   * Streams a response incrementally. Optional so that a provider which cannot
   * stream only has to implement `generate`; the agent falls back to it.
   */
  generateStream?(
    messages: ModelMessage[],
    tools?: ToolDefinition[],
    options?: GenerateOptions
  ): AsyncIterable<ModelStreamEvent>;
  supportsTools(): boolean;
}

export interface GenerateOptions {
  /** Cancels the in-flight request, including a partially consumed stream. */
  signal?: AbortSignal;
}

/**
 * A response in flight. Text arrives as `delta`s so a consumer can render
 * progressively; exactly one `complete` event terminates the stream and carries
 * the assembled response, including any tool calls.
 */
export type ModelStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'complete'; response: ModelResponse };