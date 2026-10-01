#!/usr/bin/env bun

import { KaizenAgent } from '@kaizen-harness/agent';
import { AgentLoop } from '@kaizen-harness/agent';
import { ToolRegistry } from '@kaizen-harness/tools';
import { readFileTool, writeFileTool, runCommandTool } from '@kaizen-harness/tools';
import { OpenRouterModelProvider } from '@kaizen-harness/model';

function printBanner() {
  console.log(`
╭────────────────────────────────────────────╮
│                                            │
│            Kaizen Code Agent               │
│                                            │
│    Your terminal-native coding partner     │
│                                            │
╰────────────────────────────────────────────╯
`);
}

async function main() {
  printBanner();

  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: kaizen <task>');
    console.log('Example: kaizen "fix the failing tests"');
    process.exit(1);
  }

  const task = args.join(' ');
  
  console.log(`Task: ${task}`);
  console.log('Initializing...\n');

  // Initialize components
  const modelProvider = new OpenRouterModelProvider();
  const agent = new KaizenAgent(modelProvider);
  const loop = new AgentLoop(agent);
  
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(readFileTool);
  toolRegistry.register(writeFileTool);
  toolRegistry.register(runCommandTool);

  console.log('Tools available:');
  toolRegistry.list().forEach(tool => {
    console.log(`  - ${tool.name}: ${tool.description}`);
  });

  console.log('\nStarting agent loop...\n');

  try {
    await loop.run(task);
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}

export { main };