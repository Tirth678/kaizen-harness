/**
 * Temporary probe: how many steps do realistic tasks actually take?
 * Run from a throwaway copy of the repo, since the agent writes files.
 */
import { OpenRouterModelProvider } from '@kaizen-harness/model';
import { KaizenAgent, AgentLoop } from '@kaizen-harness/agent';
import { ToolRegistry } from '@kaizen-harness/tools';
import { readFileTool } from '@kaizen-harness/tools';
import { writeFileTool } from '@kaizen-harness/tools';
import { runCommandTool } from '@kaizen-harness/tools';

const TASKS = [
  'What does the run_command tool do? Read its source and answer in one sentence.',
  'Add a test to packages/tools that verifies run_command rejects a command matching the safety policy. Then run the test suite and confirm it passes.',
];

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(runCommandTool);
  return registry;
}

for (const task of TASKS) {
  const provider = new OpenRouterModelProvider();
  const registry = buildRegistry();
  const agent = new KaizenAgent(provider, {}, registry.list());

  let tools = 0;
  let finished = false;
  const loop = new AgentLoop(agent, registry, event => {
    if (event.type === 'tool_start') tools++;
    if (event.type === 'tool_result' && event.tool === 'finish') finished = true;
  });

  const startedAt = Date.now();
  const answer = await loop.run(task);
  const steps = agent.getStep();
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('='.repeat(70));
  console.log(`TASK: ${task.slice(0, 70)}`);
  console.log(`steps=${steps} toolCalls=${tools} calledFinish=${finished} seconds=${seconds}`);
  console.log(`ANSWER: ${answer.slice(0, 400).replace(/\n/g, ' ')}`);
  console.log('');
}