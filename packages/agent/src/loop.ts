import { KaizenAgent, FINISH_TOOL_NAME } from './agent';
import { ToolRegistry } from '@kaizen-harness/tools';
import type { ToolResult } from '@kaizen-harness/tools';
import type { ModelToolCall } from '@kaizen-harness/model';
import type { AgentEvent, EventSink } from './events';
import type { AgentDecision } from './types';

const NOOP_SINK: EventSink = () => {};

/** How many recent tool calls to inspect when checking for a stalled run. */
const STAGNATION_WINDOW = 8;

/**
 * Arguments that pick a window into a resource rather than identify it. Reading
 * the same file at lines 1-7 and then 218-226 is one piece of work, not two, so
 * these are ignored when deciding whether a call is actually new.
 */
const WINDOW_PARAMS = new Set(['startLine', 'endLine']);

/** How often one subject may be revisited before the run counts as stalled. */
const MAX_SUBJECT_REVISITS = 3;

/** How many identical results in the recent past count as "this told you nothing". */
const MAX_WASTED_RESULTS = 3;

/** How many recent results are held for the duplicate check. */
const RESULT_WINDOW = 12;

/** Minimum steps between nudges, regardless of which stall is being reported. */
const NUDGE_REPEAT_EVERY = 5;

/** Consecutive blank model turns tolerated before the run is called broken. */
const MAX_CONSECUTIVE_EMPTY = 2;

/** Tools that act on a path; a call without one is always a malformed call. */
const TARGETLESS_TOOLS = new Set(['read_file', 'write_file']);

/**
 * Why the run is not advancing. `kind` is stable across steps while `detail`
 * changes, so escalation can be driven by whether this is the same complaint.
 */
interface Stall {
  kind: 'subject' | 'duplicate-results' | 'repeats' | 'single-call';
  detail: string;
}

/**
 * Restates an ongoing stall with rising pressure. The nth restatement names the
 * budget so the model can weigh finishing against one more attempt.
 */
function nudgeText(step: number, stall: Stall, repeat: boolean, times: number): string {
  if (!repeat) {
    return (
      `You have made ${step} step(s) without calling finish, and ${stall.detail}. ` +
      'Stop and either change approach, or call finish now and report what you verified ' +
      'and what is still blocking you. Do not repeat these calls again.'
    );
  }

  return (
    `Still no finish after ${step} step(s), and ${stall.detail}. You are ignoring the ` +
    `warning above (${times} now). Your next call must either be a genuinely different ` +
    'action, or finish. Repeating anything described above wastes the rest of the budget.'
  );
}

export class AgentLoop {
  private agent: KaizenAgent;
  private toolRegistry: ToolRegistry;
  private sink: EventSink;
  private isRunning: boolean = false;
  private stepCount: number = 0;
  /** Cancels the in-flight model request so stop() takes effect immediately. */
  private controller: AbortController = new AbortController();
  /** Signatures of calls that already failed, so a repeat can be called out directly. */
  private failedCalls: Map<string, number> = new Map();
  /** Every call made this run, to detect a model that is not converging. */
  private callHistory: string[] = [];
  /**
   * What each recent call was about, with window arguments folded away, so that
   * rereading one file in slices still registers as repeated work.
   */
  private subjectHistory: string[] = [];
  /** Hashes of recent result payloads, so a call that reveals nothing new is visible. */
  private recentResultHashes: string[] = [];
  /** The last stall described to the model, so a repeat is not re-explained. */
  private lastNudgedReason: Stall['kind'] | undefined;
  /** Step at which the last nudge was sent. */
  private lastNudgeStep: number = -1;
  /** How many nudges this run has sent, used to escalate the wording. */
  private nudgeCount: number = 0;
  /** Consecutive blank model turns, to tell a hiccup from a broken connection. */
  private emptyCount: number = 0;

  constructor(agent: KaizenAgent, toolRegistry: ToolRegistry, sink: EventSink = NOOP_SINK) {
    this.agent = agent;
    this.toolRegistry = toolRegistry;
    this.sink = sink;
  }

  public async run(task: string): Promise<string> {
    this.isRunning = true;
    this.stepCount = 0;
    this.failedCalls.clear();
    this.callHistory = [];
    this.subjectHistory = [];
    this.recentResultHashes = [];
    this.lastNudgedReason = undefined;
    this.lastNudgeStep = -1;
    this.nudgeCount = 0;
    this.emptyCount = 0;
    this.controller = new AbortController();
    this.agent.initialize(task);

    try {
      while (this.isRunning) {
        // Only mark a step when a model call will actually follow. The terminal
        // iteration is a budget check inside decide(), and reporting it would
        // credit work that never happened.
        //
        // The marker goes out before the call so it precedes any streamed text.
        // It carries no duration: the wait is only over once decideStream()
        // returns, and buffering the answer to fill that in would defeat
        // streaming. The renderer measures the wait itself and completes the
        // line in place when the next event arrives.
        if (this.agent.getStep() < this.agent.getMaxSteps()) {
          this.stepCount++;
          this.emit({ type: 'thinking', step: this.stepCount });
        }

        let decision: AgentDecision | undefined;
        let streamed = '';

        for await (const event of this.agent.decideStream({ signal: this.controller.signal })) {
          if (event.type === 'text') {
            // Forwarded as it arrives so a consumer can render while the model
            // is still writing, not after the whole answer is buffered.
            streamed += event.delta;
            this.emit({ type: 'text_delta', content: event.delta });
          } else {
            decision = event.decision;
          }
        }

        if (!this.isRunning || !decision) {
          break;
        }

        switch (decision.action) {
          case 'tool_calls': {
            this.emptyCount = 0;
            await this.executeToolCalls(decision.toolCalls);

            if (decision.toolCalls.some(call => call.name === FINISH_TOOL_NAME)) {
              this.isRunning = false;
              break;
            }

            // A model can spend its whole budget making calls that succeed and
            // change nothing. Tell it plainly rather than waiting for the budget
            // to run out with no answer.
            const stall = this.stallReason();
            if (stall) {
              // Re-nudging every step floods the conversation with near-identical
              // messages and crowds out the tool results that carry the signal.
              // The cooldown is on any nudge, not per complaint: a run that
              // alternates between two kinds of stall is still one stall, and
              // keying the cooldown on the kind let it re-nudge every step.
              const sinceLast = this.stepCount - this.lastNudgeStep;
              if (sinceLast >= NUDGE_REPEAT_EVERY) {
                const repeat = stall.kind === this.lastNudgedReason;
                this.lastNudgedReason = stall.kind;
                this.lastNudgeStep = this.stepCount;
                this.nudgeCount++;
                this.agent.addNudge(nudgeText(this.stepCount, stall, repeat, this.nudgeCount));
              }
            }
            break;
          }

          case 'finish':
            this.emptyCount = 0;
            // When the model streamed, the deltas above already carried this to
            // the consumer. Only emit the whole-text event if nothing streamed.
            if (streamed.length === 0) {
              this.emit({ type: 'text', content: decision.summary });
            }
            this.isRunning = false;
            break;

          case 'empty': {
            // Recover from a blank turn by telling the model plainly and letting
            // it continue. Consecutive blanks mean something is actually wrong,
            // so give up after a couple rather than looping on an empty response.
            this.emptyCount++;
            if (this.emptyCount > MAX_CONSECUTIVE_EMPTY) {
              this.emit({
                type: 'error',
                error: new Error(decision.reasoning),
              });
              this.isRunning = false;
              break;
            }

            this.agent.addNudge(
              'Your last response was empty: it contained neither text nor a tool call, so ' +
                'nothing happened. Continue the task now. Call the tools you need, or call ' +
                'finish if the work is already done and report the result.',
            );
            break;
          }

          case 'max_steps':
            this.emit({
              type: 'error',
              error: new Error(decision.reasoning),
            });
            this.isRunning = false;
            break;

          case 'error':
            this.emit({
              type: 'error',
              error: new Error(decision.reasoning),
            });
            this.isRunning = false;
            break;
        }
      }

      const answer = this.finalAnswer();
      this.emit({ type: 'done', answer, steps: this.agent.getStep() });
      return answer;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // stop() aborts the in-flight request. That is a user action, not a
      // failure, so report what was produced rather than an abort error.
      if (!this.isRunning) {
        const partial = this.finalAnswer();
        this.emit({ type: 'done', answer: partial, steps: this.agent.getStep() });
        return partial;
      }

      this.emit({ type: 'error', error: err });
      this.emit({ type: 'done', answer: err.message, steps: this.agent.getStep() });
      return err.message;
    }
  }

  public stop(): void {
    this.isRunning = false;
    // Abort as well as flipping the flag: without this an in-flight request keeps
    // reading its stream to completion and stop() would not feel immediate.
    this.controller.abort();
  }

  private emit(event: AgentEvent): void {
    this.sink(event);
  }

  private async executeToolCalls(toolCalls: ModelToolCall[]): Promise<void> {
    for (const call of toolCalls) {
      const signature = signatureOf(call);
      const priorFailures = this.failedCalls.get(signature) ?? 0;
      this.callHistory.push(signature);
      this.subjectHistory.push(subjectOf(call));

      // A byte-identical repeat cannot succeed. Skip execution entirely and say so,
      // rather than burning another round-trip on a known-dead call.
      if (priorFailures > 0) {
        const result: ToolResult = {
          success: false,
          error:
            `This exact call already failed ${priorFailures} time(s) earlier in this run. ` +
            'Repeating it verbatim cannot succeed. Change the arguments, choose a ' +
            'different tool, or finish and explain the blocker.',
        };
        this.failedCalls.set(signature, priorFailures + 1);
        this.emit({ type: 'tool_result', tool: call.name, result });
        this.agent.addToolResult(call, renderForModel(result));
        continue;
      }

      this.emit({ type: 'tool_start', tool: call.name, input: call.arguments });

      const startedAt = Date.now();
      const result = await this.toolRegistry.execute({
        tool: call.name,
        parameters: call.arguments,
      });
      const withDuration: ToolResult = {
        ...result,
        durationMs: Date.now() - startedAt,
      };

      if (!withDuration.success) {
        this.failedCalls.set(signature, priorFailures + 1);
      }

      if (withDuration.success) {
        this.recordResult(renderForModel(withDuration));
      }

      this.emit({ type: 'tool_result', tool: call.name, result: withDuration });
      this.agent.addToolResult(call, renderForModel(withDuration));
    }
  }

  /** Counts a result payload, so a repeat that reveals nothing can be spotted. */
  private recordResult(payload: string): void {
    this.recentResultHashes.push(hashPayload(payload));
    // Bounded: only the recent past indicates a stall. A run that legitimately
    // re-reads similar output early should not be judged by it forever.
    if (this.recentResultHashes.length > RESULT_WINDOW) {
      this.recentResultHashes.shift();
    }
  }

  /**
   * Describes why the run is no longer advancing, or undefined when it is.
   *
   * Exact-signature matching alone is not enough. A model that rereads one file
   * in slices produces a distinct signature every time, so it looks busy while
   * making no progress. Two extra checks close that gap: one subject revisited
   * past a threshold, and results already returned verbatim.
   */
  private stallReason(): Stall | undefined {
    // Nothing can be called a stall before there is enough of a run to judge. A
    // duplicate result in the first few calls is normal probing, not a loop.
    if (this.callHistory.length < STAGNATION_WINDOW) {
      return undefined;
    }

    const recentSubjects = this.subjectHistory.slice(-STAGNATION_WINDOW);

    if (recentSubjects.length > 0) {
      const counts = new Map<string, number>();
      for (const subject of recentSubjects) {
        counts.set(subject, (counts.get(subject) ?? 0) + 1);
      }

      let worst: { subject: string; count: number } | undefined;
      for (const [subject, count] of counts) {
        if (count >= MAX_SUBJECT_REVISITS && (!worst || count > worst.count)) {
          worst = { subject, count };
        }
      }

      if (worst) {
        const separator = worst.subject.indexOf(':');
        return {
          kind: 'subject',
          detail:
            `you have called ${worst.subject.slice(0, separator)} on ` +
            `${worst.subject.slice(separator + 1)} ${worst.count} times in the last ` +
            `${recentSubjects.length} calls without moving on`,
        };
      }
    }

    // A tool that keeps returning something recent calls already returned has
    // told the model nothing, however varied its arguments were.
    const hashes = new Map<string, number>();
    for (const hash of this.recentResultHashes) {
      hashes.set(hash, (hashes.get(hash) ?? 0) + 1);
    }

    // Identical output is only damning when it dominates the window. A tool that
    // legitimately returns a constant payload, or a command run twice, must not
    // be mistaken for a loop on the strength of three calls alone.
    let wasted = 0;
    for (const count of hashes.values()) {
      if (count >= MAX_WASTED_RESULTS) {
        wasted += count;
      }
    }

    if (wasted >= this.recentResultHashes.length / 2 && wasted > 0) {
      return {
        kind: 'duplicate-results',
        detail:
          `most of the last ${this.recentResultHashes.length} successful calls ` +
          'returned results you have already seen',
      };
    }

    const recent = this.callHistory.slice(-STAGNATION_WINDOW);

    if (new Set(recent).size <= STAGNATION_WINDOW / 2) {
      return { kind: 'repeats', detail: 'the recent calls are repeating' };
    }

    if (new Set(this.callHistory).size <= 1) {
      return {
        kind: 'single-call',
        detail: 'the whole run has used only one distinct call',
      };
    }

    return undefined;
  }

  private finalAnswer(): string {
    const finishCall = this.agent
      .getLastToolCalls()
      .find(call => call.name === FINISH_TOOL_NAME);

    if (finishCall) {
      const summary = finishCall.arguments.summary;
      if (typeof summary === 'string' && summary.length > 0) {
        return summary;
      }
    }

    for (let i = this.agent.getState().conversation.length - 1; i >= 0; i--) {
      const message = this.agent.getState().conversation[i];
      if (message && message.role === 'assistant' && !message.toolCalls?.length && message.content.trim()) {
        return message.content.trim();
      }
    }

    return 'Agent finished without producing an answer.';
  }
}

function signatureOf(call: ModelToolCall): string {
  return `${call.name}:${JSON.stringify(call.arguments)}`;
}

/**
 * What a call is about, independent of which slice of it was requested.
 *
 * Without this, a model rereading one file as startLine/endLine pairs produces a
 * fresh signature every turn and looks productive while going nowhere.
 */
function subjectOf(call: ModelToolCall): string {
  const args = { ...call.arguments };

  for (const key of Object.keys(args)) {
    if (WINDOW_PARAMS.has(key)) {
      delete args[key];
    }
  }

  // A model that omits `path` would otherwise be nudged about being stuck on `{}`,
  // which tells it nothing. Name the actual defect instead.
  if (typeof args.path === 'string' && args.path.length > 0) {
    return `${call.name}:${args.path}`;
  }
  if ('path' in args || TARGETLESS_TOOLS.has(call.name)) {
    return `${call.name}:no path`;
  }
  return `${call.name}:${JSON.stringify(args)}`;
}

/**
 * Notes a result so an identical payload can be recognised later. Failures are
 * excluded because a tool that keeps failing is a different problem, handled by
 * the repeat guard.
 */
function hashPayload(payload: string): string {
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = (hash * 31 + payload.charCodeAt(i)) | 0;
  }
  return `${payload.length}:${hash}`;
}

/**
 * What the model sees. Kept deliberately terse: this text goes back into the
 * conversation on every subsequent request, so it should carry signal only.
 */
function renderForModel(result: ToolResult): string {
  return result.success ? `OK ${JSON.stringify(result.data)}` : `ERROR ${result.error}`;
}