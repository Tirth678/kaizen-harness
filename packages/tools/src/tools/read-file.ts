import { Tool } from '../types';

const MAX_READ_BYTES = 2_000_000;

/**
 * Longest slice returned for a ranged read. A range is a request to save context,
 * so it is bounded regardless of how small the requested window is: without a cap
 * a single `endLine: 999999` would return the whole file and defeat the purpose.
 */
const MAX_RANGE_LINES = 2_000;

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a file, optionally a specific line range. Prefer a range for large files: ' +
    'it returns only the requested lines instead of the whole file.',
  parameters: {
    path: {
      type: 'string',
      description: 'Path to the file to read',
      required: true,
    },
    startLine: {
      type: 'number',
      description:
        'First line to return, 1-based and inclusive. Omit to start at the beginning of the file.',
      required: false,
    },
    endLine: {
      type: 'number',
      description:
        'Last line to return, 1-based and inclusive. Omit to read to the end of the range or file.',
      required: false,
    },
  },
  async execute(params: Record<string, any>) {
    const { path, startLine, endLine } = params;

    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('path must be a non-empty string');
    }

    const start = readBound(startLine, 'startLine');
    const end = readBound(endLine, 'endLine');

    if (start !== undefined && end !== undefined && start > end) {
      throw new Error(
        `startLine (${start}) must not be greater than endLine (${end}). ` +
          'Swap them if you want an earlier range.',
      );
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

    const raw = await file.text();
    const allLines = raw.split('\n');

    // Splitting a trailing newline leaves a phantom empty final entry. Reporting it
    // as a real line would make the returned line count disagree with the file.
    if (allLines.length > 1 && allLines[allLines.length - 1] === '') {
      allLines.pop();
    }

    const totalLines = allLines.length;
    const from = start ?? 1;
    const to = end ?? Math.min(totalLines, from + MAX_RANGE_LINES - 1);
    const sliced = allLines.slice(from - 1, to);

    if (sliced.length === 0) {
      throw new Error(
        `startLine (${from}) is past the end of ${path}, which has ${totalLines} line(s). ` +
          'Read a smaller range.',
      );
    }

    const truncatedByCap = end === undefined && totalLines > to;
    const clampedAtEnd = end !== undefined && end > totalLines;

    return {
      path,
      content: sliced.join('\n'),
      startLine: from,
      endLine: from + sliced.length - 1,
      totalLines,
      // Named so the model can tell "you asked for less than exists" apart from
      // "I gave you everything".
      partial: truncatedByCap || clampedAtEnd,
      ...(truncatedByCap
        ? { note: `Stopped at line ${to} of ${totalLines}. Read a later range to continue.` }
        : {}),
      ...(clampedAtEnd
        ? { note: `endLine ${end} is past the end of the file; stopped at line ${totalLines}.` }
        : {}),
    };
  },
};

/**
 * Validates an optional line bound. Accepts a number or a numeric string, because
 * models routinely send JSON arguments as strings even when the schema says
 * number. Rejecting a plain numeric string here would be needlessly brittle.
 */
function readBound(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`${name} must be a positive integer, got ${typeof value}`);
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }

  return parsed;
}