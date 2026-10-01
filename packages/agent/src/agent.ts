import { AgentState, AgentConfig, AgentDecision } from './types';
import { buildSystemPrompt } from './prompt';
import { ModelProvider, ModelMessage, ModelToolCall, ToolDefinition } from '@kaizen-harness/model';

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
      maxSteps: 50,
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
    });
  }

  public async decide(): Promise<AgentDecision> {
    if (this.state.step >= this.config.maxSteps) {
      return {
        action: 'max_steps',
        reasoning: `Reached maxSteps limit (${this.config.maxSteps}) without calling finish`,
      };
    }

    let response;
    try {
      response = await this.modelProvider.generate(this.state.conversation, this.tools);
    } catch (error) {
      return {
        action: 'error',
        reasoning: error instanceof Error ? error.message : 'Unknown model error',
      };
    }

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

    return {
      action: 'error',
      reasoning: 'Model returned an empty response with no tool calls',
    };
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