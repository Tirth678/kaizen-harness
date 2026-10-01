import { Tool } from '../types';

export const runCommandTool: Tool = {
  name: 'run_command',
  description: 'Execute a shell command',
  parameters: {
    command: {
      type: 'string',
      description: 'The shell command to execute',
      required: true,
    },
    workingDir: {
      type: 'string',
      description: 'Working directory for the command',
      required: false,
    },
  },
  async execute(params: Record<string, any>) {
    const { command } = params;
    
    // This would be implemented with actual shell execution
    // For now, return a placeholder response
    return {
      exitCode: 0,
      stdout: `Executed: ${command}`,
      stderr: '',
    };
  },
};