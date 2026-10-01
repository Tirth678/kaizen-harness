import { existsSync } from 'node:fs';
import { Tool } from '../types';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

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
      description:
        'Working directory for the command. Must be an existing directory. Defaults to the current directory.',
      required: false,
    },
  },
  async execute(params: Record<string, any>) {
    const { command, workingDir } = params;

    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new Error('command must be a non-empty string');
    }

    let cwd = process.cwd();
    if (workingDir !== undefined) {
      if (typeof workingDir !== 'string' || !existsSync(workingDir)) {
        throw new Error(
          `workingDir does not exist: ${String(workingDir)}. Omit workingDir to run in ${process.cwd()}.`,
        );
      }
      cwd = workingDir;
    }

    const proc = Bun.spawn({
      cmd: ['bash', '-c', command],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, DEFAULT_TIMEOUT_MS);

    try {
      const [rawStdout, rawStderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      const stdout = truncate(rawStdout, MAX_OUTPUT_CHARS);
      const stderr = truncate(rawStderr, MAX_OUTPUT_CHARS);

      if (timedOut) {
        throw new Error(
          `Command timed out after ${DEFAULT_TIMEOUT_MS}ms and was killed.\n` +
            `command: ${command}\nstdout: ${stdout}\nstderr: ${stderr}`,
        );
      }

      // A non-zero exit is a real failure. Surface it as one so the caller sees a
      // truthful status instead of a successful-looking result carrying exitCode 1.
      if (exitCode !== 0) {
        throw new Error(
          `Command failed with exit code ${exitCode}.\n` +
            `command: ${command}\nstdout: ${stdout}\nstderr: ${stderr}`,
        );
      }

      return {
        exitCode,
        stdout,
        stderr,
        cwd,
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n... [truncated ${value.length - max} of ${value.length} chars]`;
}