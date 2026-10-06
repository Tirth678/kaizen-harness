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
      // Reject arguments the tool does not declare. Silently dropping them is how
      // a model ends up calling read_file with a range the tool ignores and
      // receiving the whole file, three steps in a row, with no error to correct it.
      const unknown = Object.keys(call.parameters ?? {}).filter(
        key => !Object.prototype.hasOwnProperty.call(tool.parameters, key),
      );

      if (unknown.length > 0) {
        const accepted = Object.keys(tool.parameters);
        return {
          success: false,
          error:
            `"${call.tool}" does not accept argument(s): ${unknown.join(', ')}. ` +
            (accepted.length > 0
              ? `It accepts: ${accepted.join(', ')}. `
              : 'It accepts no arguments. ') +
            'Check the tool schema and call it again with only supported arguments.',
        };
      }

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