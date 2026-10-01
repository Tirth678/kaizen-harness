import { Tool, ToolCall, ToolResult } from './types';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.tool);

    if (!tool) {
      const available = Array.from(this.tools.keys()).join(', ');
      return {
        success: false,
        error:
          `Unknown tool "${call.tool}". Available tools: ${available}. ` +
          'Call one of those exact names. Do not retry the same unknown tool name.',
      };
    }

    try {
      const result = await tool.execute(call.parameters);
      return {
        success: true,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }
}