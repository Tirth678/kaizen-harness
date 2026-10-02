export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required?: boolean;
  }>;
  execute: (params: Record<string, any>) => Promise<any>;
}

export interface ToolCall {
  tool: string;
  parameters: Record<string, any>;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  /** Wall-clock execution time, populated by the agent loop. */
  durationMs?: number;
}