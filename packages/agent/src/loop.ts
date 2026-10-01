import { KaizenAgent, FINISH_TOOL_NAME } from './agent';
import { ToolRegistry } from '@kaizen-harness/tools';
import type { ModelToolCall } from '@kaizen-harness/model';

export class AgentLoop {
  private agent: KaizenAgent;
  private toolRegistry: ToolRegistry;
  private isRunning: boolean = false;

  constructor(agent: KaizenAgent, toolRegistry: ToolRegistry) {
    this.agent = agent;
    this.toolRegistry = toolRegistry;
  }

  public async run(task: string): Promise<string> {
    this.isRunning = true;
    this.agent.initialize(task);

    console.log('Starting Kaizen agent...\n');

    while (this.isRunning) {
      const decision = await this.agent.decide();

      if (!this.isRunning) {
        break;
      }

      switch (decision.action) {
        case 'tool_calls': {
          await this.executeToolCalls(decision.toolCalls);

          if (decision.toolCalls.some(call => call.name === FINISH_TOOL_NAME)) {
            this.isRunning = false;
            break;
          }
          break;
        }

        case 'finish':
          this.isRunning = false;
          break;

        case 'max_steps':
          console.log(`\nStopped: ${decision.reasoning}`);
          this.isRunning = false;
          break;

        case 'error':
          console.error(`\nError: ${decision.reasoning}`);
          this.isRunning = false;
          break;

        case 'respond':
          console.log(decision.message);
          break;
      }
    }

    return this.finalAnswer();
  }

  public stop(): void {
    this.isRunning = false;
  }

  private async executeToolCalls(toolCalls: ModelToolCall[]): Promise<void> {
    for (const call of toolCalls) {
      console.log(`  -> ${call.name}(${summarizeArgs(call.arguments)})`);

      const result = await this.toolRegistry.execute({
        tool: call.name,
        parameters: call.arguments,
      });

      const rendered = result.success
        ? `OK ${JSON.stringify(result.data)}`
        : `ERROR ${result.error}`;

      console.log(`  <- ${call.name}: ${truncate(rendered, 400)}`);

      this.agent.addToolResult(call, rendered);
    }
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

function summarizeArgs(args: Record<string, any>): string {
  return truncate(JSON.stringify(args), 200);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}