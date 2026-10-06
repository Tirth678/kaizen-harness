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

    // Echo back what actually arrived. A bare "path must be a non-empty string"
    // left a model retrying an identical malformed call twice, which suggests it
    // could not tell a malformed argument from a rejected one.
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(
        `write_file requires a non-empty string "path". Received ${describe(path)}. ` +
          'Nothing was written. Resend with an absolute or project-relative file path.',
      );
    }

    if (typeof content !== 'string') {
      throw new Error(
        `write_file requires a string "content". Received ${describe(content)}. ` +
          'Nothing was written. Resend with the full file content.',
      );
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

/** Names the type and value of a bad argument so the model can see what arrived. */
function describe(value: unknown): string {
  if (value === undefined) return 'no value (argument missing)';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length === 0 ? 'an empty string' : `a string of ${value.length} chars`;
  }
  if (typeof value === 'object') {
    try {
      return `an object (${JSON.stringify(value).slice(0, 120)})`;
    } catch {
      return 'an object';
    }
  }
  return `a ${typeof value} (${String(value).slice(0, 80)})`;
}