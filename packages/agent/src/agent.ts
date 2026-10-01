import { AgentState, AgentConfig, AgentDecision } from './types';
import { ModelProvider, ModelMessage } from '@kaizen-harness/model';

export class KaizenAgent {
  private state: AgentState;
  private config: AgentConfig;
  private modelProvider: ModelProvider;

  constructor(modelProvider: ModelProvider, config: Partial<AgentConfig> = {}) {
    this.modelProvider = modelProvider;
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
      {
        role: 'system',
        content: 'You are Kaizen, a coding agent that helps developers with coding tasks. You can read files, write files, and run commands to help users solve problems.',
      },
      {
        role: 'user',
        content: task,
      },
    ];
    this.state.step = 0;
  }

  public async decide(): Promise<AgentDecision> {
    if (this.state.step >= this.config.maxSteps) {
      return {
        action: 'complete',
        nextStep: 'evaluate',
        reasoning: 'Maximum steps reached',
      };
    }

    try {
      // Call the actual model
      const response = await this.modelProvider.generate(this.state.conversation);
      
      // Add assistant's response to conversation
      this.state.conversation.push({
        role: 'assistant',
        content: response.content,
      });

      this.state.step++;

      // Parse the response to determine next action
      // This is a simple implementation - in a real agent, we'd parse tool calls
      // and make more sophisticated decisions
      if (response.content.toLowerCase().includes('done') || 
          response.content.toLowerCase().includes('complete') ||
          response.content.toLowerCase().includes('finished')) {
        return {
          action: 'complete',
          nextStep: 'evaluate',
          reasoning: 'Agent indicated completion',
        };
      }

      // Check for tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        return {
          action: 'continue',
          nextStep: 'execute',
          reasoning: `Agent requested ${response.toolCalls.length} tool calls`,
        };
      }

      return {
        action: 'continue',
        nextStep: 'analyze',
        reasoning: 'Continue analysis based on model response',
      };

    } catch (error) {
      console.error(`Error in agent decision: ${error}`);
      return {
        action: 'error',
        nextStep: 'evaluate',
        reasoning: `Failed to get model response: ${error}`,
      };
    }
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
}