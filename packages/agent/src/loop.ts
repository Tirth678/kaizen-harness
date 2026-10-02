import { KaizenAgent, FINISH_TOOL_NAME } from './agent';
import { ToolRegistry } from '@kaizen-harness/tools';
import type { ToolResult } from '@kaizen-harness/tools';
import type { ModelToolCall } from '@kaizen-harness/model';
import type { AgentEvent, EventSink } from './events';
import type { AgentDecision } from './types';

const NOOP_SINK: EventSink = () => {};

/** How many recent tool calls to inspect when checking for a stalled run. */
const STAGNATION_WINDOW = 8;

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
            await this.executeToolCalls(decision.toolCalls);

            if (decision.toolCalls.some(call => call.name === FINISH_TOOL_NAME)) {
              this.isRunning = false;
              break;
            }

            // A model can spend its whole budget making calls that succeed and
            // change nothing. Tell it plainly rather than waiting for the budget
            // to run out with no answer.
            if (this.isStagnating()) {
              this.agent.addNudge(
                `You have made ${this.stepCount} step(s) without calling finish, and the recent ` +
                  'calls are repeating or not producing new information. Stop and either ' +
                  'change approach, or call finish now and report what you verified and ' +
                  'what is still blocking you. Do not repeat these calls again.',
              );
            }
            break;
          }

          case 'finish':
            // When the model streamed, the deltas above already carried this to
            // the consumer. Only emit the whole-text event if nothing streamed.
            if (streamed.length === 0) {
              this.emit({ type: 'text', content: decision.summary });
            }
            this.isRunning = false;
            break;

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

      this.emit({ type: 'tool_result', tool: call.name, result: withDuration });
      this.agent.addToolResult(call, renderForModel(withDuration));
    }
  }

  /**
   * True once recent calls stop being informative: either the same call is
   * repeating, or the run has gone a long time with only one distinct call.
   */
  private isStagnating(): boolean {
    const recent = this.callHistory.slice(-STAGNATION_WINDOW);
    if (recent.length < STAGNATION_WINDOW) {
      return false;
    }

    const repeats = new Set(recent).size <= STAGNATION_WINDOW / 2;
    const distinctTotal = new Set(this.callHistory).size;
    return repeats || distinctTotal <= 1;
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
 * What the model sees. Kept deliberately terse: this text goes back into the
 * conversation on every subsequent request, so it should carry signal only.
 */
function renderForModel(result: ToolResult): string {
  return result.success ? `OK ${JSON.stringify(result.data)}` : `ERROR ${result.error}`;
}