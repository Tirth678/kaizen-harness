export interface AgentState {
  conversation: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
  context: Record<string, any>;
  step: number;
}

export interface AgentConfig {
  maxSteps: number;
  temperature: number;
  model: string;
}

export type AgentDecision = {
  action: 'continue' | 'complete' | 'error';
  nextStep: 'analyze' | 'execute' | 'evaluate';
  reasoning: string;
};