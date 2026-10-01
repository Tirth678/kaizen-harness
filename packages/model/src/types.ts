import { z } from 'zod';

export interface ModelMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ModelResponse {
  content: string;
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, any>;
  }>;
}

export interface ModelProvider {
  generate(messages: ModelMessage[]): Promise<ModelResponse>;
  supportsTools(): boolean;
}

// OpenRouter API types
export const OpenRouterMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

export const OpenRouterToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.any()),
  }),
});

export const OpenRouterRequestSchema = z.object({
  model: z.string(),
  messages: z.array(OpenRouterMessageSchema),
  stream: z.boolean().optional(),
  max_tokens: z.number().optional(),
  temperature: z.number().optional(),
  tool_choice: z.string().optional(),
  tools: z.array(OpenRouterToolSchema).optional(),
});

export const OpenRouterChoiceSchema = z.object({
  message: z.object({
    role: z.string(),
    content: z.string().optional(),
    tool_calls: z.array(z.object({
      function: z.object({
        name: z.string(),
        arguments: z.string(),
      }),
    })).optional(),
  }),
});

export const OpenRouterResponseSchema = z.object({
  id: z.string(),
  choices: z.array(OpenRouterChoiceSchema),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
    cost: z.number(),
  }).optional(),
});

export const OpenRouterErrorSchema = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
  }),
});

export type OpenRouterRequest = z.infer<typeof OpenRouterRequestSchema>;
export type OpenRouterResponse = z.infer<typeof OpenRouterResponseSchema>;
export type OpenRouterError = z.infer<typeof OpenRouterErrorSchema>;