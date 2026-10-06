import { describe, expect, test } from 'bun:test';
import { KaizenAgent } from './agent';
import { AgentLoop } from './loop';
import { createEventLog } from './events';
import type { AgentEvent } from './events';
import { ToolRegistry, Tool } from '@kaizen-harness/tools';
import type { ModelMessage, ModelResponse } from '@kaizen-harness/model';

interface Scripted {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>;
}

function provider(script: Scripted[]) {
  const requests: ModelMessage[][] = [];
  let index = 0;
  return {
    requests,
    async generate(messages: ModelMessage[]): Promise<ModelResponse> {
      requests.push(messages.map(m => ({ ...m })));
      const step = script[index++];
      if (!step) throw new Error('fakeProvider exhausted');
      return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], finishReason: 'stop' };
    },
    supportsTools: () => true,
  };
}

/**
 * Stubs must declare their parameters. The registry rejects arguments a tool
 * does not declare, so a stub with an empty schema would fail every call the test
 * makes with real arguments.
 */
function stubTool(name: string, execute: Tool['execute'], args: string[] = []): Tool {
  return {
    name,
    description: name,
    parameters: Object.fromEntries(
      args.map(arg => [arg, { type: 'string', description: arg, required: false }]),
    ),
    execute,
  };
}

function build(script: Scripted[], tools: Tool[] = []) {
  const fake = provider(script);
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  const log = createEventLog();
  const agent = new KaizenAgent(fake, { maxSteps: 10 });
  const loop = new AgentLoop(agent, registry, log.sink);
  return { loop, events: log.events, requests: fake.requests };
}

const types = (events: AgentEvent[]) => events.map(event => event.type);

/** Narrows to a single event variant so `event.tool` and friends typecheck. */
function find<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T,
): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
}

describe('AgentLoop event stream', () => {
  test('emits thinking then text then done for a plain answer', async () => {
    const { loop, events } = build([{ content: 'The answer.' }]);
    await loop.run('question');

    expect(types(events)).toEqual(['thinking', 'text', 'done']);
    expect(find(events, 'text')[0]!.content).toBe('The answer.');
    expect(find(events, 'done')[0]).toMatchObject({ answer: 'The answer.', steps: 1 });
  });

  test('emits tool_start then tool_result around each call', async () => {
    const echo = stubTool('echo', async params => ({ echoed: params.value }), ['value']);

    const { loop, events } = build(
      [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: { value: 'x' } }] },
        { content: 'finished' },
      ],
      [echo],
    );

    await loop.run('echo x');

    expect(types(events)).toEqual([
      'thinking',
      'tool_start',
      'tool_result',
      'thinking',
      'text',
      'done',
    ]);

    const start = find(events, 'tool_start')[0]!;
    expect(start.tool).toBe('echo');
    expect(start.input).toEqual({ value: 'x' });

    const result = find(events, 'tool_result')[0]!;
    expect(result.tool).toBe('echo');
    expect(result.result.success).toBe(true);
    expect(result.result.data).toEqual({ echoed: 'x' });
  });

  test('records a duration on tool results', async () => {
    const slow = stubTool('slow', async () => {
      await Bun.sleep(15);
      return { ok: true };
    });

    const { loop, events } = build(
      [
        { toolCalls: [{ id: 'c1', name: 'slow', arguments: {} }] },
        { content: 'done' },
      ],
      [slow],
    );

    await loop.run('be slow');
    const result = find(events, 'tool_result')[0]!;
    expect(typeof result.result.durationMs).toBe('number');
    expect(result.result.durationMs).toBeGreaterThanOrEqual(10);
  });

  test('emits a failing tool_result carrying the error', async () => {
    const { loop, events } = build(
      [
        { toolCalls: [{ id: 'c1', name: 'missing', arguments: {} }] },
        { content: 'recovered' },
      ],
      [],
    );

    await loop.run('call nothing');

    const result = find(events, 'tool_result')[0]!;
    expect(result.result.success).toBe(false);
    expect(result.result.error).toContain('Unknown tool');
  });

  test('emits error then done when the provider fails', async () => {
    const failing = {
      async generate(): Promise<ModelResponse> {
        throw new Error('provider exploded');
      },
      supportsTools: () => true,
    };
    const log = createEventLog();
    const loop = new AgentLoop(
      new KaizenAgent(failing),
      new ToolRegistry(),
      log.sink,
    );

    await loop.run('anything');

    expect(types(log.events)).toEqual(['thinking', 'error', 'done']);
    expect(find(log.events, 'error')[0]!.error.message).toBe('provider exploded');
    // decide() converts the throw into a decision, so there is no real answer.
    expect(find(log.events, 'done')[0]!.steps).toBe(0);
  });

  test('emits error when the step budget is exhausted', async () => {
    const tick = stubTool('tick', async () => ({ ok: true }));
    const { loop, events } = build(
      Array.from({ length: 20 }, () => ({
        toolCalls: [{ id: 'c', name: 'tick', arguments: {} }],
      })),
      [tick],
    );

    await loop.run('loop forever');

    const errors = find(events, 'error');
    expect(errors).toHaveLength(1);
    // The message must name the cap that was hit and admit there is no answer,
    // rather than reporting bare internal config.
    expect(errors[0]!.error.message).toContain('10');
    expect(errors[0]!.error.message).toMatch(/ran out of steps/i);
    expect(errors[0]!.error.message).toMatch(/without calling finish/i);
    expect(find(events, 'done')[0]!.steps).toBe(10);
  });

  test('short-circuits an identical repeat without a second tool_start', async () => {
    let invocations = 0;
    const counted = stubTool(
      'counted',
      async () => {
        invocations++;
        throw new Error('nope');
      },
      ['a'],
    );

    const { loop, events } = build(
      [
        { toolCalls: [{ id: 'c1', name: 'counted', arguments: { a: 1 } }] },
        { toolCalls: [{ id: 'c2', name: 'counted', arguments: { a: 1 } }] },
        { content: 'gave up' },
      ],
      [counted],
    );

    await loop.run('retry');

    expect(invocations).toBe(1);
    expect(find(events, 'tool_start')).toHaveLength(1);
    expect(find(events, 'tool_result')).toHaveLength(2);
    expect(find(events, 'tool_result')[1]!.result.error).toContain('already failed');
  });

  test('does not write to stdout', async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => void lines.push(args.join(' '));
    console.error = (...args: unknown[]) => void lines.push(args.join(' '));

    try {
      const echo = stubTool('echo', async () => ({ ok: true }));
      const { loop } = build(
        [
          { toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] },
          { content: 'answer' },
        ],
        [echo],
      );
      await loop.run('stay quiet');
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    expect(lines).toEqual([]);
  });

  test('works with no sink supplied', async () => {
    const fake = provider([{ content: 'answer' }]);
    const loop = new AgentLoop(new KaizenAgent(fake), new ToolRegistry());
    await expect(loop.run('quiet by default')).resolves.toBe('answer');
  });

  test('step count increments once per decision', async () => {
    const echo = stubTool('echo', async () => ({ ok: true }));
    const { loop, events } = build(
      [
        { toolCalls: [{ id: 'c1', name: 'echo', arguments: {} }] },
        { toolCalls: [{ id: 'c2', name: 'echo', arguments: {} }] },
        { content: 'answer' },
      ],
      [echo],
    );

    await loop.run('count steps');
    expect(find(events, 'thinking').map(e => e.step)).toEqual([1, 2, 3]);
    expect(find(events, 'done')[0]!.steps).toBe(3);
  });
});