import { KaizenAgent } from './agent';

export class AgentLoop {
  private agent: KaizenAgent;
  private isRunning: boolean = false;

  constructor(agent: KaizenAgent) {
    this.agent = agent;
  }

  public async run(task: string): Promise<void> {
    this.isRunning = true;
    this.agent.initialize(task);

    console.log('Starting Kaizen agent...');
    console.log(`Task: ${task}`);

    while (this.isRunning) {
      const decision = await this.agent.decide();

      console.log(`Step ${this.agent.getState().step}: ${decision.action}`);
      console.log(`Reasoning: ${decision.reasoning}`);

      switch (decision.action) {
        case 'continue':
          // Execute next step
          break;
        case 'complete':
          console.log('Task completed successfully!');
          this.isRunning = false;
          return;
        case 'error':
          console.log('Error encountered in agent loop');
          this.isRunning = false;
          return;
      }

      // Simulate work
      await this.sleep(100);
    }
  }

  public stop(): void {
    this.isRunning = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}