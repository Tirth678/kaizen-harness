import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Tool } from '../types';

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file, creating parent directories as needed',
  parameters: {
    path: {
      type: 'string',
      description: 'Path to the file to write',
      required: true,
    },
    content: {
      type: 'string',
      description: 'Content to write to the file',
      required: true,
    },
  },
  async execute(params: Record<string, any>) {
    const { path, content } = params;

    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('path must be a non-empty string');
    }

    if (typeof content !== 'string') {
      throw new Error('content must be a string');
    }

    const parent = dirname(path);
    if (parent && parent !== '.') {
      await mkdir(parent, { recursive: true });
    }

    await Bun.write(path, content);

    return {
      path,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
    };
  },
};