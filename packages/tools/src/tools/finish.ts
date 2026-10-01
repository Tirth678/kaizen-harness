import { Tool } from '../types';

export const finishTool: Tool = {
  name: 'finish',
  description:
    'Call this when the task is complete. Include a short summary of what you did and any findings for the user.',
  parameters: {
    summary: {
      type: 'string',
      description: 'Summary of the work completed and the result for the user',
      required: true,
    },
  },
  async execute(params: Record<string, any>) {
    return {
      finished: true,
      summary: params.summary ?? '',
    };
  },
};