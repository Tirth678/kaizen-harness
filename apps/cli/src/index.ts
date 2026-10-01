#!/usr/bin/env bun

import { createInterface } from 'node:readline/promises';
import { KaizenAgent, AgentLoop } from '@kaizen-harness/agent';
import { ToolRegistry } from '@kaizen-harness/tools';
import {
  readFileTool,
  writeFileTool,
  runCommandTool,
  webSearchTool,
  finishTool,
} from '@kaizen-harness/tools';
import { OpenRouterModelProvider } from '@kaizen-harness/model';
import type { ModelProvider } from '@kaizen-harness/model';

const VERSION = '0.1.0';

function printBanner(): void {
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

function printHelp(): void {
  console.log(`
kzn — Kaizen coding agent

USAGE
  kzn                  Start an interactive agent session
  kzn <task>           Run a single task, print the answer, exit
  kzn --help, -h       Show this help
  kzn --version, -v    Show the version

INTERACTIVE COMMANDS
  /help                Show this help
  /tools               List the tools the agent can use
  /clear               Clear the screen
  /exit, /quit         Leave the session

EXAMPLES
  kzn
  kzn "fix the failing tests"
  kzn "summarize the architecture of packages/agent"

AGENT TOOLS
  read_file      Read the contents of a file
  write_file     Write content to a file
  run_command    Execute a shell command
  web_search     Search the web via Firecrawl
  finish         Report the final answer and end the run
`);
}

function buildRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(runCommandTool);
  registry.register(webSearchTool);
  registry.register(finishTool);
  return registry;
}

async function runTask(task: string, provider: ModelProvider, registry: ToolRegistry): Promise<void> {
  const agent = new KaizenAgent(provider, {}, registry.list());
  const loop = new AgentLoop(agent, registry);

  const answer = await loop.run(task);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(answer);
}

async function runInteractive(provider: ModelProvider, registry: ToolRegistry): Promise<void> {
  console.log('Type a task and press enter. /help for commands, /exit to quit.\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let running = false;
  rl.on('SIGINT', () => {
    if (running) {
      console.log('\n(agent still working — interrupt again to exit)');
      return;
    }
    rl.close();
  });

  try {
    while (true) {
      let input: string;
      try {
        input = (await rl.question('kzn> ')).trim();
      } catch {
        break;
      }

      if (!input) continue;

      if (input === '/exit' || input === '/quit') {
        console.log('Bye.');
        break;
      }

      if (input === '/help') {
        printHelp();
        continue;
      }

      if (input === '/tools') {
        console.log('');
        registry.list().forEach(tool => console.log(`  ${tool.name} — ${tool.description}`));
        console.log('');
        continue;
      }

      if (input === '/clear') {
        console.clear();
        continue;
      }

      running = true;
      try {
        await runTask(input, provider, registry);
      } catch (error) {
        console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        running = false;
      }
      console.log('');
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];

  if (first === '--help' || first === '-h' || first === 'help') {
    printHelp();
    return;
  }

  if (first === '--version' || first === '-v') {
    console.log(VERSION);
    return;
  }

  let provider: ModelProvider;
  let registry: ToolRegistry;

  try {
    provider = new OpenRouterModelProvider();
    registry = buildRegistry();
  } catch (error) {
    console.error(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error('Set SK_OR_V1_KEY in your environment or .env file.');
    process.exit(1);
  }

  printBanner();

  if (args.length === 0) {
    await runInteractive(provider, registry);
    return;
  }

  await runTask(args.join(' '), provider, registry);
}

if (import.meta.main) {
  main().catch(error => {
    console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

export { main, printHelp, buildRegistry };