import { describe, expect, test } from 'bun:test';
import { KaizenAgent } from './agent';
import { AgentLoop } from './loop';
import { createEventLog } from './events';
import type { AgentEvent } from './events';
import { ToolRegistry, Tool } from '@kaizen-harness/tools';
import type { ModelMessage, ModelResponse, ModelStreamEvent } from '@kaizen-harness/model';

interface Step {
  deltas?: string[];
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>;
}

/** A provider that streams, the way the real one does. */
function streamingProvider(script: Step[]) {
  const requests: ModelMessage[][] = [];
  let index = 0;

  return {
    requests,
    async generate(): Promise<ModelResponse> {
      throw new Error('generate() should not be used when streaming is available');
    },
    async *generateStream(messages: ModelMessage[]): AsyncGenerator<ModelStreamEvent> {
      // Snapshot, since the conversation keeps mutating between steps.
      requests.push(messages.map(m => ({ ...m })));
      const step = script[index++];
      if (!step) throw new Error('streamingProvider exhausted');

      for (const delta of step.deltas ?? []) {
        yield { type: 'text', delta };
      }

      yield {
        type: 'complete',
        response: {
          content: step.content ?? (step.deltas ?? []).join(''),
          toolCalls: step.toolCalls ?? [],
          finishReason: 'stop',
        },
      };
    },
    supportsTools: () => true,
  };
}

const stubTool = (name: string, execute: Tool['execute']): Tool => ({
  name,
  description: name,
  parameters: {},
  execute,
});

function find<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T
): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((event): event is Extract<AgentEvent, { type: T }> => event.type === type);
}

function build(script: Step[], tools: Tool[] = []) {
  const fake = streamingProvider(script);
  const registry = new ToolRegistry();
  for (const tool of tools) {
    registry.register(tool);
  }
  const log = createEventLog();
  const agent = new KaizenAgent(fake, { maxSteps: 10 }, registry.list());
  const loop = new AgentLoop(agent, registry, log.sink);
  return { loop, agent, events: log.events, requests: fake.requests };
}

describe('text streaming', () => {
  test('emits one text_delta per chunk, in order', async () => {
    const { loop, events } = build([{ deltas: ['Once', ' upon', ' a time'] }]);

    await loop.run('go');

    const deltas = find(events, 'text_delta').map(event => event.content);
    expect(deltas).toEqual(['Once', ' upon', ' a time']);
  });

  test('the deltas concatenate to the final answer', async () => {
    const { loop, events } = build([{ deltas: ['Hello', ' ', 'world'] }]);

    const answer = await loop.run('go');

    expect(find(events, 'text_delta').map(e => e.content).join('')).toBe(answer);
    expect(answer).toBe('Hello world');
  });

  test('does not also emit a whole-text event when text was streamed', async () => {
    const { loop, events } = build([{ deltas: ['a', 'b'] }]);

    await loop.run('go');

    expect(find(events, 'text')).toHaveLength(0);
  });

  test('deltas arrive before the done event so a consumer can render live', async () => {
    const { loop, events } = build([{ deltas: ['x', 'y'] }]);

    await loop.run('go');

    const lastDelta = events.findIndex(event => event.type === 'text_delta');
    const done = events.findIndex(event => event.type === 'done');
    expect(lastDelta).toBeLessThan(done);
  });

  test('streams a preamble and then runs a tool', async () => {
    const read = stubTool('read_file', async () => ({ ok: true }));
    const { loop, events } = build(
      [
        {
          deltas: ['Let me look.'],
          toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }],
        },
        { deltas: ['It is 173 lines.'] },
      ],
      [read]
    );

    await loop.run('go');

    expect(find(events, 'text_delta').map(e => e.content).join('')).toBe(
      'Let me look.It is 173 lines.'
    );
    expect(find(events, 'tool_result')).toHaveLength(1);
  });

  test('the streamed answer is recorded on the assistant turn', async () => {
    const { loop, agent } = build([{ deltas: ['Hi', ' there'] }]);

    await loop.run('go');

    // The conversation is what the next step would be sent, so it has to carry the
    // assembled text rather than the last delta.
    const assistant = agent
      .getState()
      .conversation.find(message => message.role === 'assistant');
    expect(assistant?.content).toBe('Hi there');
  });
});

describe('providers without streaming', () => {
  test('falls back to a whole-text event and no deltas', async () => {
    const fake = {
      async generate(): Promise<ModelResponse> {
        return { content: 'one shot', finishReason: 'stop' };
      },
      supportsTools: () => true,
    };

    const registry = new ToolRegistry();
    const log = createEventLog();
    const loop = new AgentLoop(new KaizenAgent(fake, { maxSteps: 5 }, []), registry, log.sink);

    const answer = await loop.run('go');

    expect(answer).toBe('one shot');
    expect(find(log.events, 'text_delta')).toHaveLength(0);
    expect(find(log.events, 'text')[0]?.content).toBe('one shot');
  });
});

describe('decideStream', () => {
  test('yields deltas and ends with a decision', async () => {
    const fake = streamingProvider([{ deltas: ['p', 'q'] }]);
    const agent = new KaizenAgent(fake, { maxSteps: 5 }, []);
    agent.initialize('go');

    const deltas: string[] = [];
    let decision;

    for await (const event of agent.decideStream()) {
      if (event.type === 'text') deltas.push(event.delta);
      else decision = event.decision;
    }

    expect(deltas).toEqual(['p', 'q']);
    expect(decision?.action).toBe('finish');
  });

  test('reports the budget without calling the model', async () => {
    const fake = streamingProvider([]);
    const agent = new KaizenAgent(fake, { maxSteps: 0 }, []);
    agent.initialize('go');

    const events = [];
    for await (const event of agent.decideStream()) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'decision', decision: { action: 'max_steps' } });
    expect(fake.requests).toHaveLength(0);
  });

  test('turns a mid-stream failure into an error decision', async () => {
    const fake = {
      async generate(): Promise<ModelResponse> {
        throw new Error('unused');
      },
      async *generateStream(): AsyncGenerator<ModelStreamEvent> {
        yield { type: 'text', delta: 'partial' };
        throw new Error('connection reset');
      },
      supportsTools: () => true,
    };

    const agent = new KaizenAgent(fake, { maxSteps: 5 }, []);
    agent.initialize('go');

    let decision;
    for await (const event of agent.decideStream()) {
      if (event.type === 'decision') decision = event.decision;
    }

    expect(decision).toMatchObject({ action: 'error', reasoning: 'connection reset' });
  });
});

describe('stop()', () => {
  test('aborts the in-flight stream instead of draining it', async () => {
    let observedSignal: AbortSignal | undefined;

    const fake = {
      async generate(): Promise<ModelResponse> {
        throw new Error('unused');
      },
      async *generateStream(
        _messages: ModelMessage[],
        _tools: unknown,
        options: { signal?: AbortSignal }
      ): AsyncGenerator<ModelStreamEvent> {
        observedSignal = options.signal;

        while (true) {
          if (options.signal?.aborted) {
            throw new Error('The operation was aborted');
          }
          yield { type: 'text', delta: 'tick ' };
          await Bun.sleep(5);
        }
      },
      supportsTools: () => true,
    };

    const registry = new ToolRegistry();
    const log = createEventLog();
    const loop = new AgentLoop(new KaizenAgent(fake, { maxSteps: 50 }, []), registry, log.sink);

    const run = loop.run('go');
    await Bun.sleep(30);
    loop.stop();
    const answer = await run;

    expect(observedSignal?.aborted).toBe(true);
    // A user-requested stop is not a failure.
    expect(find(log.events, 'error')).toHaveLength(0);
    expect(find(log.events, 'done')).toHaveLength(1);
    expect(answer.length).toBeGreaterThan(0);
  });

  test('nudges the model once its calls stop producing new information', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('tick', async () => ({ ok: true })));

    // Always the same call, never finishing. This is the shape of a stalled run.
    const fake = streamingProvider(
      Array.from({ length: 12 }, () => ({
        toolCalls: [{ id: `c${Math.random()}`, name: 'tick', arguments: {} }],
      })),
    );

    const log = createEventLog();
    const loop = new AgentLoop(new KaizenAgent(fake, { maxSteps: 12 }, registry.list()), registry, log.sink);
    await loop.run('go');

    // The nudge has to reach the model, so assert on the conversation the next
    // model call would have been given.
    const conversation = fake.requests.at(-1) ?? [];
    const nudges = conversation.filter(
      m => m.role === 'user' && /without calling finish/i.test(m.content),
    );
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges[0]!.content).toMatch(/change approach/i);
  });

  test('does not nudge a run that varies its calls', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('tick', async () => ({ ok: true })));

    const fake = streamingProvider(
      Array.from({ length: 10 }, (_, i) => ({
        toolCalls: [{ id: `c${i}`, name: 'tick', arguments: { i } }],
      })),
    );

    const log = createEventLog();
    const loop = new AgentLoop(new KaizenAgent(fake, { maxSteps: 10 }, registry.list()), registry, log.sink);
    await loop.run('go');

    const conversation = fake.requests.at(-1) ?? [];
    const nudges = conversation.filter(
      m => m.role === 'user' && /without calling finish/i.test(m.content),
    );
    expect(nudges).toHaveLength(0);
  });
});