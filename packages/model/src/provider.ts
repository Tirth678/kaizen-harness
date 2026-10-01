import { ModelMessage, ModelResponse, ModelProvider, ModelToolCall, ToolDefinition } from './types';

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

  async generate(messages: ModelMessage[], tools?: ToolDefinition[]): Promise<ModelResponse> {
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

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/kaizen-harness',
          'X-Title': 'Kaizen Code Agent',
        },
        body: JSON.stringify(requestData),
      });

      const responseData = await response.json();

      if (!response.ok) {
        const message = responseData?.error?.message || response.statusText;
        throw new Error(`OpenRouter API error (${response.status}): ${message}`);
      }

      const choice = responseData?.choices?.[0];
      if (!choice) {
        throw new Error('No response from model');
      }

      const message = choice.message;

      let toolCalls: ModelToolCall[] | undefined;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        toolCalls = message.tool_calls.map((call: any, index: number) => ({
          id: call.id ?? `call_${index}`,
          name: call.function?.name ?? '',
          arguments: safeParseArguments(call.function?.arguments),
        }));
      }

      return {
        content: message.content || '',
        toolCalls,
        finishReason: choice.finish_reason,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to generate response: ${error.message}`);
      }
      throw new Error('Failed to generate response: Unknown error');
    }
  }

  supportsTools(): boolean {
    return true;
  }
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