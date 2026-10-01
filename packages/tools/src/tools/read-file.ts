import { Tool } from '../types';

const MAX_READ_BYTES = 2_000_000;

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file',
  parameters: {
    path: {
      type: 'string',
      description: 'Path to the file to read',
      required: true,
    },
  },
  async execute(params: Record<string, any>) {
    const { path } = params;

    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('path must be a non-empty string');
    }

    const file = Bun.file(path);

    if (!(await file.exists())) {
      throw new Error(`File not found: ${path}`);
    }

    if (file.size > MAX_READ_BYTES) {
      throw new Error(
        `File is too large to read: ${path} (${file.size} bytes, limit ${MAX_READ_BYTES}). ` +
          'Use run_command with a targeted command instead.',
      );
    }

    const content = await file.text();

    return {
      path,
      content,
      size: file.size,
    };
  },
};