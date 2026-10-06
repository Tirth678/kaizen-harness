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

  test('nudges when one file is reread in slices, which looks busy but is not', async () => {
    // The observed failure: a model reread the same test file six times as
    // different startLine/endLine pairs. Every signature differed, so the old
    // exact-match guard saw six distinct calls and never fired.
    const registry = new ToolRegistry();
    registry.register(
      stubTool('read_file', async () => ({ content: 'x' }), ['path', 'startLine', 'endLine']),
    );

    const fake = streamingProvider(
      Array.from({ length: 12 }, (_, i) => ({
        toolCalls: [
          {
            id: `c${i}`,
            name: 'read_file',
            arguments: { path: '/repo/tools.test.ts', startLine: i * 10 + 1, endLine: i * 10 + 9 },
          },
        ],
      })),
    );

    const log = createEventLog();
    const loop = new AgentLoop(
      new KaizenAgent(fake, { maxSteps: 12 }, registry.list()),
      registry,
      log.sink,
    );
    await loop.run('go');

    const conversation = fake.requests.at(-1) ?? [];
    const nudges = conversation.filter(
      m => m.role === 'user' && /without calling finish/i.test(m.content),
    );
    expect(nudges.length).toBeGreaterThan(0);
    // Naming the target makes the nudge actionable instead of generic.
    expect(nudges[0]!.content).toContain('read_file');
    expect(nudges[0]!.content).toContain('/repo/tools.test.ts');
  });

  test('nudges when calls return a result the run has already seen', async () => {
    // Distinct arguments, identical output: the model is not learning anything.
    const registry = new ToolRegistry();
    registry.register(stubTool('probe', async () => ({ same: true }), ['i']));

    const fake = streamingProvider(
      Array.from({ length: 12 }, (_, i) => ({
        toolCalls: [{ id: `c${i}`, name: 'probe', arguments: { i } }],
      })),
    );

    const log = createEventLog();
    const loop = new AgentLoop(
      new KaizenAgent(fake, { maxSteps: 12 }, registry.list()),
      registry,
      log.sink,
    );
    await loop.run('go');

    const conversation = fake.requests.at(-1) ?? [];
    const nudges = conversation.filter(
      m => m.role === 'user' && /already seen/i.test(m.content),
    );
    expect(nudges.length).toBeGreaterThan(0);
  });

  test('does not nudge a productive run that revisits one file only twice', async () => {
    const registry = new ToolRegistry();
    // Distinct content per window, as a real read_file returns. Identical
    // payloads would be a genuine stall, which the previous test covers.
    registry.register(
      stubTool(
        'read_file',
        async params => ({ content: `${params.path}:${params.startLine}` }),
        ['path', 'startLine', 'endLine'],
      ),
    );

    // Two windows on one file, plus varied other work, is normal investigation.
    const fake = streamingProvider([
      { toolCalls: [{ id: 'c0', name: 'read_file', arguments: { path: '/a.ts', startLine: 1, endLine: 20 } }] },
      { toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: '/a.ts', startLine: 21, endLine: 40 } }] },
      { toolCalls: [{ id: 'c2', name: 'read_file', arguments: { path: '/b.ts', startLine: 1, endLine: 20 } }] },
      { toolCalls: [{ id: 'c3', name: 'read_file', arguments: { path: '/c.ts', startLine: 1, endLine: 20 } }] },
      { content: 'finished reading' },
    ]);

    const log = createEventLog();
    const loop = new AgentLoop(
      new KaizenAgent(fake, { maxSteps: 10 }, registry.list()),
      registry,
      log.sink,
    );
    await loop.run('go');

    const conversation = fake.requests.at(-1) ?? [];
    const nudges = conversation.filter(
      m => m.role === 'user' && /without calling finish/i.test(m.content),
    );
    expect(nudges).toHaveLength(0);
  });

  test('names the defect when a file tool is called without a path', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('write_file', async () => ({ ok: true })));

    // A model that forgot `path` used to be nudged about being stuck on `{}`.
    // Naming the missing argument tells it what to actually fix.
    // Enough steps to fill the stagnation window, and the missing `path` every
    // time so the subject repeats.
    const fake = streamingProvider(
      Array.from({ length: 10 }, () => ({
        toolCalls: [{ id: 'c0', name: 'write_file', arguments: { content: 'x' } }],
      })),
    );

    const log = createEventLog();
    const loop = new AgentLoop(
      new KaizenAgent(fake, { maxSteps: 10 }, registry.list()),
      registry,
      log.sink,
    );
    await loop.run('go');

    const conversation = fake.requests.at(-1) ?? [];
    const notice = conversation.find(
      m => m.role === 'user' && /without moving on/.test(m.content),
    );
    expect(notice).toBeDefined();
    expect(notice!.content).toMatch(/no path/);
    // The raw serialized arguments must not leak into the nudge.
    expect(notice!.content).not.toContain('{}');
  });

  test('recovers from an empty model response instead of ending the run', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('tick', async () => ({ ok: true })));

    // An observed run threw away eighteen steps of real exploration because the
    // model returned one blank turn. A blank turn is a hiccup, not a verdict.
    const fake = streamingProvider([
      { toolCalls: [{ id: 'c0', name: 'tick', arguments: {} }] },
      { deltas: [] },
      { toolCalls: [{ id: 'c1', name: 'tick', arguments: {} }] },
      { deltas: ['recovered and finished'] },
    ]);

    const log = createEventLog();
    const loop = new AgentLoop(
      new KaizenAgent(fake, { maxSteps: 10 }, registry.list()),
      registry,
      log.sink,
    );
    const answer = await loop.run('go');

    expect(answer).toBe('recovered and finished');
    // The blank turn must not be reported as the end of the run.
    expect(find(log.events, 'error')).toHaveLength(0);
    // And the model must be told what happened, or it may repeat the blank turn.
    const conversation = fake.requests.at(-1) ?? [];
    const notices = conversation.filter(
      m => m.role === 'user' && /neither text nor a tool call/i.test(m.content),
    );
    expect(notices).toHaveLength(1);
  });

  test('gives up after consecutive empty responses', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('tick', async () => ({ ok: true })));

    // Two blanks in a row means the connection or the model is genuinely broken.
    // Retrying forever would spin without ever making progress.
    const fake = streamingProvider(Array.from({ length: 6 }, () => ({ deltas: [] })));

    const log = createEventLog();
    const loop = new AgentLoop(
      new KaizenAgent(fake, { maxSteps: 6 }, registry.list()),
      registry,
      log.sink,
    );
    await loop.run('go');

    expect(find(log.events, 'error').length).toBeGreaterThan(0);
    expect(find(log.events, 'error')[0]!.error.message).toMatch(/empty/i);
    // It must stop early rather than burning the whole budget on blank turns.
    expect(find(log.events, 'thinking').length).toBeLessThanOrEqual(4);
  });

  test('a blank turn does not count against the consecutive-empty limit once work resumes', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('tick', async () => ({ ok: true })));

    const fake = streamingProvider([
      { deltas: [] },
      { toolCalls: [{ id: 'c0', name: 'tick', arguments: {} }] },
      { deltas: [] },
      { toolCalls: [{ id: 'c1', name: 'tick', arguments: {} }] },
      { deltas: ['done'] },
    ]);

    const log = createEventLog();
    const loop = new AgentLoop(
      new KaizenAgent(fake, { maxSteps: 10 }, registry.list()),
      registry,
      log.sink,
    );
    const answer = await loop.run('go');

    expect(answer).toBe('done');
    expect(find(log.events, 'error')).toHaveLength(0);
  });

  test('does not restate a stall on every single step', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('read_file', async () => ({ ok: true }), ['path', 'startLine']));

    // A run that is stuck for many steps. Nudging every step would bury the tool
    // results that carry the signal under near-identical warnings.
    const fake = streamingProvider(
      Array.from({ length: 30 }, (_, i) => ({
        toolCalls: [
          {
            id: `c${i}`,
            name: 'read_file',
            arguments: { path: '/repo/same.ts', startLine: i + 1 },
          },
        ],
      })),
    );

    const log = createEventLog();
    const loop = new AgentLoop(
      new KaizenAgent(fake, { maxSteps: 30 }, registry.list()),
      registry,
      log.sink,
    );
    await loop.run('go');

    const conversation = fake.requests.at(-1) ?? [];
    const nudges = conversation.filter(
      m => m.role === 'user' && /without calling finish/i.test(m.content),
    );

    // Stuck for ~22 eligible steps, but the warning must stay rare enough to read.
    expect(nudges.length).toBeGreaterThan(0);
    expect(nudges.length).toBeLessThanOrEqual(6);
    // The repeats escalate rather than repeating verbatim.
    expect(new Set(nudges.map(m => m.content)).size).toBe(nudges.length);
  });

  test('does not judge a run on the first few calls', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('probe', async () => ({ same: true }), ['i']));

    // Identical output three times in a row is normal early probing, not a loop.
    const fake = streamingProvider(
      Array.from({ length: 4 }, (_, i) => ({
        toolCalls: [{ id: `c${i}`, name: 'probe', arguments: { i } }],
      })),
    );

    const log = createEventLog();
    const loop = new AgentLoop(
      new KaizenAgent(fake, { maxSteps: 4 }, registry.list()),
      registry,
      log.sink,
    );
    await loop.run('go');

    const conversation = fake.requests.at(-1) ?? [];
    const nudges = conversation.filter(
      m => m.role === 'user' && /without calling finish/i.test(m.content),
    );
    expect(nudges).toHaveLength(0);
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