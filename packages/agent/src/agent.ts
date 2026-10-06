import { AgentState, AgentConfig, AgentDecision } from './types';
import type { AgentStreamEvent, DecideOptions } from './types';
import { buildSystemPrompt } from './prompt';
import { ModelProvider, ModelMessage, ModelToolCall, ToolDefinition } from '@kaizen-harness/model';
import type { ModelResponse } from '@kaizen-harness/model';

export const FINISH_TOOL_NAME = 'finish';

export class KaizenAgent {
  private state: AgentState;
  private config: AgentConfig;
  private modelProvider: ModelProvider;
  private tools: ToolDefinition[];
  private lastToolCalls: ModelToolCall[] = [];

  constructor(modelProvider: ModelProvider, config: Partial<AgentConfig> = {}, tools: ToolDefinition[] = []) {
    this.modelProvider = modelProvider;
    this.tools = tools;
    this.config = {
      // Each step is a real billed model call, so this is a cost ceiling. It has
      // to cover the work *and* the verification that follows: an observed run
      // implementing a two-file tool correctly ran out at 25 before it ever
      // executed its own tests. A healthy model ends the run by calling finish,
      // so a high ceiling costs nothing until the model is actually stuck, and
      // stagnation nudging handles that case.
      maxSteps: 40,
      temperature: 0.7,
      model: 'poolside/laguna-s-2.1',
      ...config,
    };

    this.state = {
      conversation: [],
      context: {},
      step: 0,
    };
  }

  public initialize(task: string): void {
    this.state.conversation = [
      { role: 'system', content: this.systemPrompt() },
      { role: 'user', content: task },
    ];
    this.state.step = 0;
    this.lastToolCalls = [];
  }

  private systemPrompt(): string {
    return buildSystemPrompt({
      model: this.config.model,
      toolNames: this.tools.map(tool => tool.name),
      maxSteps: this.config.maxSteps,
      workingDirectory: this.config.workingDirectory,
    });
  }

  public async decide(options: DecideOptions = {}): Promise<AgentDecision> {
    let decision: AgentDecision = {
      action: 'error',
      reasoning: 'Agent produced no decision',
    };

    for await (const event of this.decideStream(options)) {
      if (event.type === 'decision') {
        decision = event.decision;
      }
    }

    return decision;
  }

  /**
   * One reasoning step. Text deltas are yielded as they arrive so a caller can
   * render progressively; the run always ends with a `decision`.
   */
  public async *decideStream(options: DecideOptions = {}): AsyncGenerator<AgentStreamEvent> {
    if (this.state.step >= this.config.maxSteps) {
      yield {
        type: 'decision',
decision: {
            action: 'max_steps',
            reasoning:
              `Ran out of steps (${this.config.maxSteps}) without calling finish. ` +
              'No verified answer was produced for this task.',
          },
      };
      return;
    }

    const stream = this.modelProvider.generateStream?.bind(this.modelProvider);

    // A provider that cannot stream still works; it just yields no deltas.
    if (!stream) {
      yield { type: 'decision', decision: await this.decideOnce(options) };
      return;
    }

    let content = '';

    try {
      for await (const event of stream(this.state.conversation, this.tools, options)) {
        if (event.type === 'text') {
          content += event.delta;
          yield { type: 'text', delta: event.delta };
        } else {
          yield { type: 'decision', decision: this.classify(event.response) };
          return;
        }
      }
    } catch (error) {
      yield {
        type: 'decision',
        decision: {
          action: 'error',
          reasoning: error instanceof Error ? error.message : 'Unknown model error',
        },
      };
      return;
    }

    // The stream ended without a `complete` event, so fall back to whatever text
    // arrived rather than losing it.
    yield {
      type: 'decision',
      decision: this.classify({ content, finishReason: 'stop' }),
    };
  }

  private async decideOnce(options: DecideOptions = {}): Promise<AgentDecision> {
    let response;
    try {
      response = await this.modelProvider.generate(this.state.conversation, this.tools, options);
    } catch (error) {
      return {
        action: 'error',
        reasoning: error instanceof Error ? error.message : 'Unknown model error',
      };
    }

    return this.classify(response);
  }

  /** Records the turn and works out what it means for the run. */
  private classify(response: ModelResponse): AgentDecision {
    this.state.step++;

    const toolCalls = response.toolCalls ?? [];
    this.lastToolCalls = toolCalls;

    // Echo the assistant turn back with its tool_calls so the provider can match
    // subsequent `tool` messages by id.
    this.state.conversation.push({
      role: 'assistant',
      content: response.content,
      ...(toolCalls.length ? { toolCalls } : {}),
    });

    if (toolCalls.length > 0) {
      return {
        action: 'tool_calls',
        reasoning: `Model requested ${toolCalls.length} tool call(s)`,
        toolCalls,
      };
    }

    const text = response.content.trim();

    // A model that stops calling tools but hasn't finished is nudging us; treat a
    // plain final answer as terminal so the loop can't spin forever.
    if (text.length > 0) {
      return {
        action: 'finish',
        reasoning: 'Model produced a final answer without requesting more tools',
        summary: text,
      };
    }

    // A blank turn is a protocol hiccup, not a verdict on the whole run. An
    // observed run discarded eighteen steps of real exploration because the model
    // happened to return nothing once. Report it as recoverable and let the loop
    // decide, since only the loop knows how much budget is left.
    return {
      action: 'empty',
      reasoning: 'Model returned an empty response with no tool calls',
    };
  }

  /**
   * Appends a steering message from the harness, not the model. Used when the
   * loop can see that a run is stalling and the model needs to be told, rather
   * than waiting for the step budget to run out with no answer.
   */
  public addNudge(content: string): void {
    this.state.conversation.push({ role: 'user', content });
  }

  public addToolResult(toolCall: ModelToolCall, content: string): void {
    this.state.conversation.push({
      role: 'tool',
      content,
      toolCallId: toolCall.id,
      name: toolCall.name,
    });
  }

  public getState(): AgentState {
    return { ...this.state };
  }

  /** Number of model round-trips completed so far. */
  public getStep(): number {
    return this.state.step;
  }

  public getMaxSteps(): number {
    return this.config.maxSteps;
  }

  public updateContext(key: string, value: any): void {
    this.state.context[key] = value;
  }

  public addMessage(message: ModelMessage): void {
    this.state.conversation.push(message);
  }

  public getLastToolCalls(): ModelToolCall[] {
    return this.lastToolCalls;
  }
}