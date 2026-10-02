import type { AgentEvent, EventSink } from '@kaizen-harness/agent';
import type { ToolResult } from '@kaizen-harness/tools';

const RESET = '[0m';
const DIM = '[2m';
const BOLD = '[1m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const CYAN = '[36m';
const BRIGHT_WHITE = '[97m';

export interface RenderOptions {
  /**
   * Raw output sink. No newline is appended, because streamed text must stay on
   * one line and grow in place. Defaults to stdout.
   */
  write?: (chunk: string) => void;
  /** Emit ANSI escapes. Defaults to on when stdout is a TTY. */
  color?: boolean;
  /** Render the per-step "thinking" marker. On by default. */
  showThinking?: boolean;
  /** Longest single-line summary before truncation. */
  maxWidth?: number;
}

interface Palette {
  dim(text: string): string;
  bold(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  /** Bold bright white: reserved for the agent's final output. */
  final(text: string): string;
}

function makePalette(enabled: boolean): Palette {
  const wrap = (code: string) => (text: string) => (enabled ? `${code}${text}${RESET}` : text);
  const boldWrap = wrap(BOLD);
  return {
    dim: wrap(DIM),
    bold: boldWrap,
    red: wrap(RED),
    green: wrap(GREEN),
    yellow: wrap(YELLOW),
    cyan: wrap(CYAN),
    final: (text: string) => wrap(`${BOLD}${BRIGHT_WHITE}`)(text),
  };
}

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) {
    return flat;
  }
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return '';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Elapsed time for a step, in minutes and seconds once it passes a minute. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }
  const totalSeconds = ms / 1000;

  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = Math.floor(totalSeconds % 60);
    return `${totalMinutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

/**
 * A one-line description of what a tool was asked to do. Deliberately tool-aware:
 * dumping JSON here is what made the old output unreadable.
 */
export function summarizeInput(tool: string, input: unknown, max = 100): string {
  const args = (input ?? {}) as Record<string, any>;

  switch (tool) {
    case 'run_command': {
      const command = oneLine(String(args.command ?? ''), max);
      return args.workingDir ? `${command}  (in ${args.workingDir})` : command;
    }
    case 'read_file':
      return String(args.path ?? '');
    case 'write_file':
      return String(args.path ?? '');
    case 'web_search':
      return `“${oneLine(String(args.query ?? ''), max)}”`;
    case 'finish':
      return '';
    default:
      return oneLine(JSON.stringify(input ?? {}), max);
  }
}

/** A one-line description of what a tool produced. */
export function summarizeResult(tool: string, result: ToolResult, max = 100): string {
  if (!result.success) {
    return oneLine(String(result.error ?? 'failed'), max);
  }

  const data = (result.data ?? {}) as Record<string, any>;

  switch (tool) {
    case 'run_command': {
      const stdout = oneLine(String(data.stdout ?? ''), max);
      return stdout.length > 0 ? stdout : '(no output)';
    }
    case 'read_file':
      return data.size !== undefined ? formatBytes(Number(data.size)) : '';
    case 'write_file':
      return data.bytesWritten !== undefined
        ? `wrote ${formatBytes(Number(data.bytesWritten))}`
        : '';
    case 'web_search':
      return data.count !== undefined ? `${data.count} result(s)` : '';
    case 'finish':
      return '';
    default:
      return oneLine(JSON.stringify(result.data ?? {}), max);
  }
}

function shouldUseColor(): boolean {
  // https://no-color.org and the FORCE_COLOR convention.
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '0') {
    return true;
  }
  return Boolean(process.stdout.isTTY);
}

/**
 * Turns the agent event stream into terminal output. The agent itself never prints,
 * so this is the single place formatting decisions live.
 */
export function createRenderer(options: RenderOptions = {}): EventSink {
  const write = options.write ?? ((chunk: string) => void process.stdout.write(chunk));
  /** Line-oriented output. Streamed text uses `write` directly instead. */
  const line = (text = ''): void => write(`${text}\n`);
  const color = options.color ?? shouldUseColor();
  const showThinking = options.showThinking ?? true;
  const maxWidth = options.maxWidth ?? Math.min(process.stdout.columns ?? 100, 160);
  const c = makePalette(color);

  let lastText = '';
  let errorSeen = false;
  /** True once a streamed block has been opened for the current answer. */
  let streaming = false;
  let streamedText = '';
  /**
   * Deltas arrive without trailing newlines, so the cursor can be left mid-line.
   * Anything printed next has to close that line first or it lands on the answer.
   */
  let lineOpen = false;

  // A pending `… thinking` marker has no newline yet; its elapsed time is
  // appended when the next event closes it.
  let thinkingOpen = false;
  let thinkingAt = 0;

const closeLine = (): void => {
    finishThinking();
    if (lineOpen) {
      line();
      lineOpen = false;
    }
    // Line-oriented output ends any streamed block, so the next delta starts a
    // fresh one with its own leading blank line.
    streaming = false;
  };

  /**
   * Completes a pending `… thinking` marker with how long the wait actually was.
   *
   * The marker is written without a newline when the step starts, so the line
   * is completed in place the moment the model produces its first output. The
   * wait can only be measured here: by the time the loop knows the model is done,
   * streamed text may already be on screen.
   */
  const finishThinking = (): void => {
    if (!thinkingOpen) {
      return;
    }
    thinkingOpen = false;
    const elapsed = formatElapsed(Date.now() - thinkingAt);
    if (elapsed) {
      write(c.dim(` ${elapsed}`));
    }
    line();
  };

  /** Prints a whole answer block under a rule, skipping if already shown. */
  const writeAnswer = (text: string, withRule: boolean): void => {
    closeLine();
    if (withRule) {
      line(c.dim('─'.repeat(Math.min(maxWidth, 60))));
    }
    for (const answerLine of text.split('\n')) {
      line(c.final(answerLine));
    }
  };

  return (event: AgentEvent): void => {
    switch (event.type) {
      case 'thinking': {
        closeLine();
        if (showThinking) {
          thinkingOpen = true;
          thinkingAt = Date.now();
          write(`  ${c.dim('… thinking')}`);
        }
        break;
      }

      case 'tool_start': {
        closeLine();
        const detail = summarizeInput(event.tool, event.input, maxWidth);
        const label = c.bold(c.cyan(event.tool));
        line(detail ? `${label} ${c.dim('›')} ${detail}` : label);
        break;
      }

      case 'tool_result': {
        closeLine();
        const ok = event.result.success;
        const mark = ok ? c.green('✓') : c.red('✗');
        const summary = summarizeResult(event.tool, event.result, maxWidth);
        const timing = formatDuration(event.result.durationMs);

        const meta = [summary, timing && c.dim(timing)].filter(Boolean).join(c.dim(' · '));
        line(ok ? `  ${mark} ${meta || c.dim('done')}` : `  ${mark} ${c.red(meta)}`);
        break;
      }

      case 'text_delta': {
        // Written straight through, with no newline of its own, so the answer
        // appears on one growing line as the model produces it.
        if (!streaming) {
          closeLine();
          line();
          streaming = true;
        }

        streamedText += event.content;
        write(c.final(event.content));
        lineOpen = !event.content.endsWith('\n');
        break;
      }

      case 'text': {
        // Emitted when the model did not stream. If a stream already showed this
        // text, do not print it a second time.
        if (streamedText === event.content) {
          break;
        }
        lastText = event.content;
        writeAnswer(event.content, false);
        break;
      }

      case 'error': {
        closeLine();
        errorSeen = true;
        for (const errorLine of event.error.message.split('\n')) {
          line(`  ${c.red('✗')} ${c.red(errorLine)}`);
        }
        break;
      }

      case 'done': {
        // A run that ended in an error carries a placeholder answer. Printing it
        // after the real error reads as a second, unrelated failure.
        if (errorSeen) {
          closeLine();
          break;
        }
        // A streamed answer is already on screen; `done` repeats the same text.
        if (event.answer && event.answer !== streamedText && event.answer !== lastText) {
          // `done` always introduces the answer with a rule when it is not
          // already displayed, so the answer reads as the run's conclusion.
          writeAnswer(event.answer, true);
        } else {
          closeLine();
        }
        break;
      }
    }
  };
}