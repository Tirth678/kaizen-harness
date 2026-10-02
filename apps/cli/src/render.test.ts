import { describe, expect, test } from 'bun:test';
import { createRenderer, summarizeInput, summarizeResult, formatElapsed } from './render';
import type { AgentEvent } from '@kaizen-harness/agent';

/**
 * Collects raw chunks the way a terminal would: split on newlines, hold the
 * unterminated tail as the current line. This is what makes a streamed answer
 * observable as one growing line rather than a list of fragments.
 */
function collector(lines: string[]): Sink {
  let pending = '';
  let raw = '';

  const sink = ((chunk: string) => {
    raw += chunk;
    pending += chunk;
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) {
      lines.push(part);
    }
  }) as Sink;

  /** Everything written so far, exactly as a terminal would receive it. */
  sink.raw = () => raw;
  /** The unterminated tail, i.e. the line currently being streamed. */
  sink.current = () => pending;
  return sink;
}

interface Sink {
  (chunk: string): void;
  raw(): string;
  current(): string;
}

function capture(): { lines: string[]; render: (event: AgentEvent) => void } {
  const lines: string[] = [];
  return {
    lines,
    render: createRenderer({ write: collector(lines), color: false }),
  };
}

/** A renderer wired to a sink whose raw output can be asserted on. */
function streaming(options: { color?: boolean } = {}) {
  const lines: string[] = [];
  const write = collector(lines);
  const render = createRenderer({ write, color: options.color ?? false });
  return { lines, write, render, raw: () => write.raw(), live: () => write.current() };
}

const ok = (data: any, durationMs?: number) => ({
  success: true,
  data,
  ...(durationMs !== undefined ? { durationMs } : {}),
});
const fail = (error: string) => ({ success: false, error });

describe('summarizeInput', () => {
  test('shows the shell command, not JSON', () => {
    expect(summarizeInput('run_command', { command: 'ls -la' })).toBe('ls -la');
  });

  test('includes workingDir for run_command', () => {
    expect(summarizeInput('run_command', { command: 'pwd', workingDir: '/tmp' })).toBe(
      'pwd  (in /tmp)',
    );
  });

  test('collapses a multiline command onto one line', () => {
    expect(summarizeInput('run_command', { command: 'a\n  b\n\tc' })).toBe('a b c');
  });

  test('truncates an overlong command', () => {
    const summary = summarizeInput('run_command', { command: 'x'.repeat(300) }, 40);
    expect(summary.length).toBeLessThanOrEqual(40);
    expect(summary.endsWith('…')).toBe(true);
  });

  test('shows the path for file tools', () => {
    expect(summarizeInput('read_file', { path: 'a/b.ts' })).toBe('a/b.ts');
    expect(summarizeInput('write_file', { path: 'a/b.ts' })).toBe('a/b.ts');
  });

  test('quotes the search query', () => {
    expect(summarizeInput('web_search', { query: 'bun runtime' })).toBe('“bun runtime”');
  });

  test('is empty for finish', () => {
    expect(summarizeInput('finish', { summary: 'x' })).toBe('');
  });

  test('falls back to compact JSON for unknown tools', () => {
    expect(summarizeInput('mystery', { a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });
});

describe('summarizeResult', () => {
  test('prefers the error message on failure', () => {
    expect(summarizeResult('run_command', fail('Command failed with exit code 1.'))).toBe(
      'Command failed with exit code 1.',
    );
  });

  test('truncates a multiline error to one line', () => {
    expect(summarizeResult('run_command', fail('line one\nline two'))).toBe('line one line two');
  });

  test('shows stdout for run_command', () => {
    expect(summarizeResult('run_command', ok({ stdout: '3\n' }))).toBe('3');
  });

  test('says so when a command produced no output', () => {
    expect(summarizeResult('run_command', ok({ stdout: '' }))).toBe('(no output)');
  });

  test('formats file sizes', () => {
    expect(summarizeResult('read_file', ok({ size: 512 }))).toBe('512 B');
    expect(summarizeResult('read_file', ok({ size: 2048 }))).toBe('2.0 KB');
    expect(summarizeResult('read_file', ok({ size: 3 * 1024 * 1024 }))).toBe('3.0 MB');
  });

  test('formats bytes written', () => {
    expect(summarizeResult('write_file', ok({ bytesWritten: 2048 }))).toBe('wrote 2.0 KB');
  });

  test('formats the search result count', () => {
    expect(summarizeResult('web_search', ok({ count: 5 }))).toBe('5 result(s)');
  });

  test('is empty for finish', () => {
    expect(summarizeResult('finish', ok({ finished: true, summary: 'done' }))).toBe('');
  });
});

describe('createRenderer', () => {
  test('renders a tool start as a labelled call, never raw JSON', () => {
    const { lines, render } = capture();
    render({ type: 'tool_start', tool: 'run_command', input: { command: 'ls -la' } });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('run_command');
    expect(lines[0]).toContain('ls -la');
    expect(lines[0]).not.toContain('{');
  });

  test('marks success and failure distinctly', () => {
    const { lines, render } = capture();
    render({ type: 'tool_result', tool: 'run_command', result: ok({ stdout: '3' }, 12) });
    render({ type: 'tool_result', tool: 'run_command', result: fail('boom') });

    expect(lines[0]).toContain('✓');
    expect(lines[0]).toContain('3');
    expect(lines[0]).toContain('12ms');
    expect(lines[1]).toContain('✗');
    expect(lines[1]).toContain('boom');
  });

  test('formats sub-second and multi-second durations', () => {
    const { lines, render } = capture();
    render({ type: 'tool_result', tool: 'x', result: ok({ stdout: '' }, 900) });
    render({ type: 'tool_result', tool: 'x', result: ok({ stdout: '' }, 2500) });

    expect(lines[0]).toContain('900ms');
    expect(lines[1]).toContain('2.5s');
  });

  test('renders errors without an answer block', () => {
    const { lines, render } = capture();
    render({ type: 'error', error: new Error('provider exploded') });
    render({ type: 'done', answer: 'Agent finished without producing an answer.', steps: 1 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('✗');
    expect(lines[0]).toContain('provider exploded');
  });

  test('renders each line of a multiline error', () => {
    const { lines, render } = capture();
    render({ type: 'error', error: new Error('first\nsecond') });
    expect(lines).toHaveLength(2);
  });

  test('prints the answer under a separator on done', () => {
    const { lines, render } = capture();
    render({ type: 'done', answer: 'The final answer.', steps: 2 });

    expect(lines[lines.length - 1]).toBe('The final answer.');
    expect(lines[lines.length - 2]).toMatch(/^─+$/);
  });

  test('does not print the same answer twice when text and done agree', () => {
    const { lines, render } = capture();
    render({ type: 'text', content: 'Only once.' });
    render({ type: 'done', answer: 'Only once.', steps: 1 });

const answerPrints = lines.map(line => line.trim()).filter(line => line === 'Only once.');
expect(answerPrints).toHaveLength(1);
  });

  test('does not print an empty answer', () => {
    const { lines, render } = capture();
    render({ type: 'done', answer: '', steps: 1 });
    expect(lines).toHaveLength(0);
  });

test('renders thinking with elapsed time and no step number', () => {
    const { render, lines, live, raw } = streaming();

    render({ type: 'thinking', step: 3 });

    // Still unterminated, so the elapsed time can be appended in place.
    expect(lines).toHaveLength(0);
    expect(live()).toContain('… thinking');
    expect(live()).not.toContain('step');
    expect(live()).not.toContain('(3)');

    render({ type: 'done', answer: 'done', steps: 3 });

    expect(lines.join('\n')).toContain('… thinking');
    expect(lines.join('\n')).toMatch(/… thinking \d/);
    expect(raw()).toMatch(/… thinking \d+\.\d+s/);
  });

test('thinking appears before streamed text, not after', () => {
    const { render, raw } = streaming();

    render({ type: 'thinking', step: 1 });
    render({ type: 'text_delta', content: 'the answer' });
    render({ type: 'done', answer: 'the answer', steps: 1 });

    const output = raw();
    expect(output.indexOf('… thinking')).toBeLessThan(output.indexOf('the answer'));
    expect(output).toMatch(/… thinking [^\n]*\n\nthe answer\n/);
  });

test('thinking is completed with elapsed time before a tool call', () => {
    const { render, raw } = streaming();

    render({ type: 'thinking', step: 1 });
    render({ type: 'tool_start', tool: 'run_command', input: { command: 'ls' } });

    expect(raw()).toMatch(/… thinking [^\n]*\nrun_command › ls\n/);
  });

test('formats elapsed time in minutes and seconds past a minute', () => {
    expect(formatElapsed(1200)).toBe('1.2s');
    expect(formatElapsed(65_000)).toBe('1m 5s');
    expect(formatElapsed(3_725_000)).toBe('1h 2m');
});

test('suppresses thinking when disabled', () => {
    const lines: string[] = [];
    const quiet = createRenderer({
      write: collector(lines),
      color: false,
      showThinking: false,
    });

    quiet({ type: 'thinking', step: 1 });
    quiet({ type: 'done', answer: 'done', steps: 1 });

    expect(lines.join('\n')).not.toContain('thinking');
  });

  test('styles final output as bold bright white', () => {
    const lines: string[] = [];
    const render = createRenderer({ write: collector(lines), color: true });

    render({ type: 'text', content: 'the answer' });
    const styled = lines[lines.length - 1]!;

    expect(styled).toContain('[1m');
    expect(styled).toContain('[97m');
    expect(styled).toContain('the answer');
  });

test('leaves intermediate tool output dim rather than final-white', () => {
    const lines: string[] = [];
    const render = createRenderer({ write: collector(lines), color: true });

    render({ type: 'tool_result', tool: 'run_command', result: ok({ stdout: 'data' }) });
    const styled = lines[0]!;

    expect(styled).not.toContain('[97m');
  });

test('emits no ANSI escapes when color is disabled', () => {
    const { lines, render } = capture();
    render({ type: 'tool_start', tool: 'run_command', input: { command: 'ls' } });
    render({ type: 'tool_result', tool: 'run_command', result: ok({ stdout: 'a' }) });

    expect(lines.join('\n')).not.toContain('[');
  });

  test('emits ANSI escapes when color is enabled', () => {
    const lines: string[] = [];
    const render = createRenderer({ write: collector(lines), color: true });
    render({ type: 'tool_result', tool: 'run_command', result: ok({ stdout: 'a' }) });

    expect(lines.join('\n')).toContain('[');
  });

  test('handles a missing input or data without crashing', () => {
    const { lines, render } = capture();
    expect(() => render({ type: 'tool_start', tool: 'run_command', input: undefined })).not.toThrow();
    expect(() => render({ type: 'tool_result', tool: 'run_command', result: ok(undefined) })).not.toThrow();
    expect(lines.length).toBe(2);
  });
});

describe('streaming output', () => {
  test('grows the answer on one line as deltas arrive', () => {
    const { render, raw } = streaming();

    render({ type: 'text_delta', content: 'Hello' });
    expect(raw()).toBe('\nHello');

    render({ type: 'text_delta', content: ', ' });
    expect(raw()).toBe('\nHello, ');

    render({ type: 'text_delta', content: 'world' });
    expect(raw()).toBe('\nHello, world');
  });

  test('does not reprint the answer on done', () => {
    const { render, raw } = streaming();

    render({ type: 'text_delta', content: 'Hello, world' });
    render({ type: 'done', answer: 'Hello, world', steps: 1 });

    // Trailing newline terminates the line so the prompt starts clean.
    expect(raw()).toBe('\nHello, world\n');
  });

  test('closes the streamed line before the next event', () => {
    const { render, lines } = streaming();

    render({ type: 'text_delta', content: 'partial' });
    render({ type: 'tool_start', tool: 'run_command', input: { command: 'ls' } });

    // Without the break the tool line would be glued onto the answer.
    expect(lines).toEqual(['', 'partial', 'run_command › ls']);
  });

  test('a delta ending in a newline needs no extra break', () => {
    const { render, lines } = streaming();

    render({ type: 'text_delta', content: 'line one\n' });
    render({ type: 'tool_start', tool: 'read_file', input: {} });

    expect(lines).toEqual(['', 'line one', 'read_file']);
  });

  test('handles multi-line deltas', () => {
    const { render, lines } = streaming();

    render({ type: 'text_delta', content: 'one\ntwo\n' });
    render({ type: 'text_delta', content: 'three' });

    expect(lines).toEqual(['', 'one', 'two']);
  });

  test('separates a second streamed block from the first', () => {
    const { render, lines, live } = streaming();

    render({ type: 'text_delta', content: 'preamble' });
    render({ type: 'tool_result', tool: 'read_file', result: ok({ size: 10 }) });
    render({ type: 'text_delta', content: 'the answer' });

    // The answer is still streaming, so it is the live line rather than a
    // terminated one, and it must be preceded by a blank line.
    expect(live()).toBe('the answer');
    expect(lines[lines.length - 1]).toBe('');
  });

  test('styles streamed deltas as final output', () => {
    const { render, raw } = streaming({ color: true });

    render({ type: 'text_delta', content: 'answer' });

    expect(raw()).toContain('\u001b[1m');
    expect(raw()).toContain('\u001b[97m');
    expect(raw()).toContain('answer');
  });

  test('ignores a whole-text event a stream already displayed', () => {
    const { render, raw } = streaming();

    render({ type: 'text_delta', content: 'same' });
    render({ type: 'text', content: 'same' });

    expect(raw()).toBe('\nsame');
  });

  test('still prints a text event when nothing was streamed', () => {
    const { render, lines } = streaming();

    render({ type: 'text', content: 'non streaming' });

    expect(lines).toContain('non streaming');
  });

  test('a finish-tool answer is shown after a preamble streamed', () => {
    const { render, lines } = streaming();

    render({ type: 'text_delta', content: 'working on it' });
    render({ type: 'done', answer: 'All done.', steps: 2 });

    expect(lines[lines.length - 1]).toBe('All done.');
    expect(lines).toContain('working on it');
  });

  test('closes the line on done so the shell prompt starts clean', () => {
    const { render, lines } = streaming();

    render({ type: 'text_delta', content: 'answer' });
    render({ type: 'done', answer: 'answer', steps: 1 });

    expect(lines).toEqual(['', 'answer']);
  });
});
