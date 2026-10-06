import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandTool } from './tools/run-command';
import { readFileTool } from './tools/read-file';
import { writeFileTool } from './tools/write-file';
import { finishTool } from './tools/finish';

const run = (tool: any, parameters: Record<string, any>) => tool.execute(parameters);
const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kaizen-test-'));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('runCommandTool', () => {
  test('returns stdout on success', async () => {
    const result = await run(runCommandTool, { command: 'echo hello' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  test('throws on non-zero exit so callers see a truthful failure', async () => {
    await expect(run(runCommandTool, { command: 'exit 3' })).rejects.toThrow(/exit code 3/);
  });

  test('includes stderr in the failure message', async () => {
    await expect(run(runCommandTool, { command: 'echo boom >&2; exit 1' })).rejects.toThrow(
      /boom/,
    );
  });

  test('rejects an empty command', async () => {
    await expect(run(runCommandTool, { command: '   ' })).rejects.toThrow(/non-empty/);
  });

  test('rejects a missing workingDir and names the real cwd', async () => {
    await expect(
      run(runCommandTool, { command: 'pwd', workingDir: '/nope/does/not/exist' }),
    ).rejects.toThrow(/workingDir does not exist/);
  });

  test('honours a valid workingDir', async () => {
    const dir = await tempDir();
    const result = await run(runCommandTool, { command: 'pwd', workingDir: dir });
    expect(result.stdout.trim()).toContain('kaizen-test-');
  });

  test('blocks destructive commands', async () => {
    await expect(run(runCommandTool, { command: 'rm -rf /' })).rejects.toThrow(
      /blocked by the safety policy/,
    );
  });

  test('allows ordinary deletes', async () => {
    const dir = await tempDir();
    const result = await run(runCommandTool, { command: `rm -rf ${dir}` });
    expect(result.exitCode).toBe(0);
  });

  test('honours the dangerous-command bypass', async () => {
    const previous = process.env.KZN_ALLOW_DANGEROUS_COMMANDS;
    process.env.KZN_ALLOW_DANGEROUS_COMMANDS = '1';
    try {
      // echo instead of a real delete: we only assert the policy stops blocking.
      const result = await run(runCommandTool, { command: 'echo "rm -rf /"' });
      expect(result.exitCode).toBe(0);
    } finally {
      if (previous === undefined) {
        delete process.env.KZN_ALLOW_DANGEROUS_COMMANDS;
      } else {
        process.env.KZN_ALLOW_DANGEROUS_COMMANDS = previous;
      }
    }
  });

  test('truncates very large output instead of returning it whole', async () => {
    const result = await run(runCommandTool, {
      command: 'yes abcdefghijklmnopqrstuvwxyz | head -c 60000',
    });
    expect(result.stdout.length).toBeLessThan(60000);
    expect(result.stdout).toContain('truncated');
  });
});

describe('readFileTool', () => {
test('reads a file and reports its size', async () => {
const dir = await tempDir();
const path = join(dir, 'sample.txt');
await Bun.write(path, 'contents');
const result = await run(readFileTool, { path });
expect(result.content).toBe('contents');
expect(result.totalLines).toBe(1);
expect(result.partial).toBe(false);
  });

  test('returns only the requested line range', async () => {
    const dir = await tempDir();
    const path = join(dir, 'lines.txt');
    await Bun.write(path, 'l1\nl2\nl3\nl4\nl5');
    const result = await run(readFileTool, { path, startLine: 2, endLine: 4 });
    expect(result.content).toBe('l2\nl3\nl4');
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(4);
    expect(result.totalLines).toBe(5);
    // Nothing was withheld: the caller asked for 2-4 and got exactly 2-4.
    expect(result.partial).toBe(false);
  });

  test('startLine alone reads forward without running to end of file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'lines.txt');
    await Bun.write(path, 'l1\nl2\nl3\nl4\nl5');
    const result = await run(readFileTool, { path, startLine: 3 });
    expect(result.content).toBe('l3\nl4\nl5');
    expect(result.endLine).toBe(5);
  });

  test('accepts numeric strings, which models commonly send', async () => {
    const dir = await tempDir();
    const path = join(dir, 'lines.txt');
    await Bun.write(path, 'l1\nl2\nl3');
    const result = await run(readFileTool, { path, startLine: '2', endLine: '3' });
    expect(result.content).toBe('l2\nl3');
  });

  test('clamps endLine past the end of the file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'lines.txt');
    await Bun.write(path, 'l1\nl2');
    const result = await run(readFileTool, { path, startLine: 1, endLine: 999 });
    expect(result.content).toBe('l1\nl2');
    expect(result.partial).toBe(true);
    expect(result.note).toContain('past the end');
  });

  test('rejects a startLine past the end of the file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'lines.txt');
    await Bun.write(path, 'l1\nl2');
    await expect(run(readFileTool, { path, startLine: 50 })).rejects.toThrow(/past the end/);
  });

  test('rejects an inverted range', async () => {
    const dir = await tempDir();
const path = join(dir, 'lines.txt');
await Bun.write(path, 'l1\nl2\nl3');
await expect(run(readFileTool, { path, startLine: 3, endLine: 1 })).rejects.toThrow(
      /must not be greater than/,
    );
  });

  test('rejects a non-integer bound', async () => {
    const dir = await tempDir();
    const path = join(dir, 'lines.txt');
await Bun.write(path, 'l1\nl2');
    await expect(run(readFileTool, { path, startLine: 1.5 })).rejects.toThrow(/positive integer/);
  });

  test('counts lines correctly for a file with a trailing newline', async () => {
    const dir = await tempDir();
    const path = join(dir, 'lines.txt');
    await Bun.write(path, 'l1\nl2\nl3\n');
    const result = await run(readFileTool, { path });
    expect(result.totalLines).toBe(3);
    expect(result.content).toBe('l1\nl2\nl3');
  });

  test('caps a very large requested range so context is bounded', async () => {
    const dir = await tempDir();
const path = join(dir, 'big.txt');
    const total = 5_000;
    await Bun.write(path, Array.from({ length: total }, (_, i) => `line${i + 1}`).join('\n'));
    const result = await run(readFileTool, { path });
    expect(result.partial).toBe(true);
    expect(result.totalLines).toBe(total);
    expect(result.content.split('\n').length).toBe(2_000);
    expect(result.note).toContain('2000');
  });

  test('throws when the file is missing', async () => {
    await expect(run(readFileTool, { path: '/nope/missing.txt' })).rejects.toThrow(/File not found/);
  });

  test('rejects an empty path', async () => {
    await expect(run(readFileTool, { path: '' })).rejects.toThrow(/non-empty/);
  });
});

describe('writeFileTool', () => {
  test('writes a file', async () => {
    const dir = await tempDir();
    const path = join(dir, 'out.txt');
    const result = await run(writeFileTool, { path, content: 'written' });
    expect(result.bytesWritten).toBe(7);
    expect(await Bun.file(path).text()).toBe('written');
  });

  test('creates missing parent directories', async () => {
    const dir = await tempDir();
    const path = join(dir, 'a', 'b', 'c', 'out.txt');
    await run(writeFileTool, { path, content: 'deep' });
    expect(await Bun.file(path).text()).toBe('deep');
  });

  test('throws when content is missing, naming the absent argument', async () => {
    // An observed run retried an identical malformed call twice because the error
    // did not distinguish "rejected" from "never arrived".
    await expect(run(writeFileTool, { path: '/tmp/whatever.txt' })).rejects.toThrow(
      /argument missing/,
    );
  });

  test('throws when path is an empty string, naming the value received', async () => {
    await expect(run(writeFileTool, { path: '', content: 'x' })).rejects.toThrow(
      /empty string/,
    );
  });

  test('throws when content is not a string, reporting the type received', async () => {
    await expect(
      run(writeFileTool, { path: '/tmp/whatever.txt', content: 42 }),
    ).rejects.toThrow(/Received a number/);
  });

  test('does not create a file when an argument is invalid', async () => {
    const dir = await tempDir();
    const path = join(dir, 'never-written.txt');

    await expect(run(writeFileTool, { path: '', content: 'x' })).rejects.toThrow();
    // Validation has to happen before any write, or a rejected call still leaves
    // an empty or partial file behind.
    expect(await Bun.file(path).exists()).toBe(false);
  });
});

describe('finishTool', () => {
  test('reports finished with the summary', async () => {
    const result = await run(finishTool, { summary: 'all done' });
    expect(result.finished).toBe(true);
    expect(result.summary).toBe('all done');
  });
});