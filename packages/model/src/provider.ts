import { ModelMessage, ModelResponse, ModelProvider, ToolDefinition } from './types';
import type { GenerateOptions, ModelStreamEvent } from './types';

export class OpenRouterModelProvider implements ModelProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private temperature: number;
  private maxTokens: number;

  constructor(options?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    temperature?: number;
    maxTokens?: number;
  }) {
    this.apiKey = options?.apiKey || process.env.SK_OR_V1_KEY || '';
    this.model = options?.model || 'poolside/laguna-s-2.1';
    this.baseUrl = options?.baseUrl || 'https://openrouter.ai/api/v1';
    this.temperature = options?.temperature ?? 0.7;
    this.maxTokens = options?.maxTokens ?? 2000;

    if (!this.apiKey) {
      throw new Error('OpenRouter API key is required. Set SK_OR_V1_KEY environment variable or pass apiKey option.');
    }
  }

  private serializeMessage(message: ModelMessage): Record<string, unknown> {
    switch (message.role) {
      case 'assistant': {
        const payload: Record<string, unknown> = {
          role: 'assistant',
          content: message.content,
        };
        if (message.toolCalls?.length) {
          payload.tool_calls = message.toolCalls.map(call => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          }));
        }
        return payload;
      }
      case 'tool':
        return {
          role: 'tool',
          content: message.content,
          tool_call_id: message.toolCallId,
        };
      default:
        return { role: message.role, content: message.content };
    }
  }

  private buildToolSchemas(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map(tool => {
      // `required` is a boolean on our Tool.parameters but must be an array at the
      // object level in JSON Schema. Strip it from properties to avoid schema violations.
      const properties = Object.fromEntries(
        Object.entries(tool.parameters).map(([name, spec]) => {
          const { required: _required, ...rest } = spec;
          return [name, rest];
        })
      );

      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties,
            required: Object.entries(tool.parameters)
              .filter(([, spec]) => spec.required)
              .map(([name]) => name),
          },
        },
      };
    });
  }

  private buildRequestData(messages: ModelMessage[], tools?: ToolDefinition[]): Record<string, unknown> {
    const requestData: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(message => this.serializeMessage(message)),
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };

    if (tools?.length) {
      requestData.tools = this.buildToolSchemas(tools);
      requestData.tool_choice = 'auto';
    }

    return requestData;
  }

  async generate(
    messages: ModelMessage[],
    tools?: ToolDefinition[],
    options: GenerateOptions = {}
  ): Promise<ModelResponse> {
    // Deliberately the same code path as streaming: collecting a stream is the
    // non-streaming case, so the two can never disagree about wire behavior.
    let response: ModelResponse | undefined;
    for await (const event of this.generateStream(messages, tools, options)) {
      if (event.type === 'complete') {
        response = event.response;
      }
    }

    if (!response) {
      throw new Error('Failed to generate response: stream ended without a response');
    }
    return response;
  }

  async *generateStream(
    messages: ModelMessage[],
    tools?: ToolDefinition[],
    options: GenerateOptions = {}
  ): AsyncGenerator<ModelStreamEvent> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/kaizen-harness',
          'X-Title': 'Kaizen Code',
        },
        body: JSON.stringify({ ...this.buildRequestData(messages, tools), stream: true }),
        signal: options.signal ?? null,
      });
    } catch (error) {
      throw new Error(`Failed to generate response: ${describe(error)}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Failed to generate response: OpenRouter API error (${response.status}): ${apiErrorMessage(detail) || response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Failed to generate response: OpenRouter returned an empty stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    let content = '';
    let finishReason: string | undefined;
    let done = false;
    let sawChoice = false;
    /** Tool calls stream as fragments keyed by their index in the array. */
    const pendingCalls = new Map<number, { id?: string; name: string; args: string }>();

    try {
      while (!done) {
        const { done: finished, value } = await reader.read();
        if (finished) {
          break;
        }

        // `stream: true` matters for multi-byte characters: a chunk can end
        // mid-codepoint, and decoding it eagerly would corrupt the text.
        buffer += decoder.decode(value, { stream: true });

        for (const payload of drainFrames(buffer)) {
          buffer = payload.rest;

          if (payload.data === '[DONE]') {
            done = true;
            break;
          }

          const chunk = parseJson(payload.data);
          const choice = chunk?.choices?.[0];
          if (!choice) {
            continue;
          }
          sawChoice = true;

          const delta = choice.delta ?? {};
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            content += delta.content;
            yield { type: 'text', delta: delta.content };
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const [position, call] of delta.tool_calls.entries()) {
              const index = typeof call?.index === 'number' ? call.index : position;
              const pending = pendingCalls.get(index) ?? { name: '', args: '' };
              if (call?.id) pending.id = call.id;
              if (call?.function?.name) pending.name = call.function.name;
              if (typeof call?.function?.arguments === 'string') {
                pending.args += call.function.arguments;
              }
              pendingCalls.set(index, pending);
            }
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
        }
      }
    } catch (error) {
      throw new Error(`Failed to generate response: ${describe(error)}`);
    } finally {
      reader.releaseLock();
    }

    if (!sawChoice) {
      throw new Error('Failed to generate response: No response from model');
    }

    const toolCalls =
      pendingCalls.size === 0
        ? undefined
        : [...pendingCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([index, call]) => ({
              id: call.id ?? `call_${index}`,
              name: call.name,
              arguments: safeParseArguments(call.args),
            }));

    yield {
      type: 'complete',
      response: { content, toolCalls, finishReason },
    };
  }

  supportsTools(): boolean {
    return true;
  }
}

/**
 * Pulls every complete SSE frame out of `buffer`, returning the payloads plus
 * whatever trailing partial frame is left for the next read.
 */
function drainFrames(buffer: string): { data: string; rest: string }[] {
  const frames: { data: string; rest: string }[] = [];

  for (;;) {
    const match = /\r?\n\r?\n/.exec(buffer);
    if (!match) {
      break;
    }

    const frame = buffer.slice(0, match.index);
    buffer = buffer.slice(match.index + match[0].length);

    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('');

    if (data.length > 0) {
      frames.push({ data, rest: '' });
    }
  }

  // Carry the incomplete tail forward on the last entry.
  if (frames.length > 0) {
    frames[frames.length - 1]!.rest = buffer;
  } else {
    return [{ data: '', rest: buffer }];
  }

  return frames;
}

function parseJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function apiErrorMessage(body: string): string {
  const parsed = parseJson(body);
  return parsed?.error?.message ?? '';
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // AbortError is how a cancelled request surfaces; keep it recognizable.
    return error.name === 'AbortError' ? 'Request aborted' : error.message;
  }
  return 'Unknown error';
}

function safeParseArguments(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object') {
    return raw as Record<string, any>;
  }
  if (typeof raw !== 'string' || raw.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}