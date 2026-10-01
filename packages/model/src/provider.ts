import { ModelMessage, ModelResponse, ModelProvider, OpenRouterRequestSchema, OpenRouterResponseSchema, OpenRouterErrorSchema } from './types';

export class OpenRouterModelProvider implements ModelProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(options?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  }) {
    this.apiKey = options?.apiKey || process.env.SK_OR_V1_KEY || '';
    this.model = options?.model || 'poolside/laguna-s-2.1';
    this.baseUrl = options?.baseUrl || 'https://openrouter.ai/api/v1';
    
    if (!this.apiKey) {
      throw new Error('OpenRouter API key is required. Set SK_OR_V1_KEY environment variable or pass apiKey option.');
    }
  }

  async generate(messages: ModelMessage[]): Promise<ModelResponse> {
    const requestData = {
      model: this.model,
      messages,
      temperature: 0.7,
      max_tokens: 2000,
    };

    // Validate request
    const validatedRequest = OpenRouterRequestSchema.parse(requestData);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/kaizen-harness',
          'X-Title': 'Kaizen Code Agent',
        },
        body: JSON.stringify(validatedRequest),
      });

      const responseData = await response.json();

      if (!response.ok) {
        const error = OpenRouterErrorSchema.safeParse(responseData);
        if (error.success) {
          throw new Error(`OpenRouter API error (${error.data.error.code}): ${error.data.error.message}`);
        } else {
          throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
        }
      }

      const validatedResponse = OpenRouterResponseSchema.parse(responseData);

      if (validatedResponse.choices.length === 0) {
        throw new Error('No response from model');
      }

      const choice = validatedResponse.choices[0];
      if (!choice) {
        throw new Error('No choices in response');
      }
      const message = choice.message;

      // Parse tool calls if present
      const toolCalls = message.tool_calls?.map(toolCall => ({
        name: toolCall.function.name,
        arguments: JSON.parse(toolCall.function.arguments),
      }));

      return {
        content: message.content || '',
        toolCalls,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to generate response: ${error.message}`);
      }
      throw new Error('Failed to generate response: Unknown error');
    }
  }

  supportsTools(): boolean {
    return true; // OpenRouter models support tools
  }

  // Helper method to get usage stats if needed
  getUsageStats(): { promptTokens: number; completionTokens: number; totalTokens: number; cost: number } | null {
    // This would track usage across multiple calls
    // For now, we return null - actual usage is in the response
    return null;
  }
}