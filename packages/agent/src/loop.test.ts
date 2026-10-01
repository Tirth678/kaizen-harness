import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { KaizenAgent } from './agent';
import { AgentLoop } from './loop';
import { ToolRegistry, Tool } from '@kaizen-harness/tools';
import type { ModelMessage, ModelResponse } from '@kaizen-harness/model';

interface ScriptedResponse {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, any> }>;
}

/**
 * Deterministic stand-in for a real provider. Records every request so tests can
 * assert on the conversation that was actually sent back to the model.
 */
function fakeProvider(script: ScriptedResponse[]) {
  const requests: ModelMessage[][] = [];
  let index = 0;

  const provider = {
    async generate(messages: ModelMessage[]): Promise<ModelResponse> {
      // Snapshot: the agent mutates its conversation array in place, so holding the
      // reference would make every recorded request identical to the final state.
      requests.push(messages.map(message => ({ ...message })));
      const step = script[index++];
      if (!step) {
        throw new Error(`fakeProvider ran out of scripted responses at step ${index}`);
      }
      return {
        content: step.content ?? '',
        toolCalls: step.toolCalls ?? [],
        finishReason: 'stop',
      };
    },
    supportsTools() {
      return true;
    },
  };

  return { provider, requests };
}

const stubTool = (name: string, execute: Tool['execute']): Tool => ({
  name,
  description: name,
  parameters: {},
  execute,
});

function build(
  script: ScriptedResponse[],
  options: { tools?: Tool[]; maxSteps?: number } = {},
) {
  const { provider, requests } = fakeProvider(script);
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) {
    registry.register(tool);
  }
  const agent = new KaizenAgent(provider, { maxSteps: options.maxSteps ?? 10 });
  const loop = new AgentLoop(agent, registry);
  return { agent, loop, requests };
}

const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  // The loop narrates its progress; keep that out of the test output.
  console.log = () => {};
  console.error = () => {};
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
});

describe('AgentLoop', () => {
  test('returns a plain text answer without calling tools', async () => {
    const { loop, requests } = build([{ content: 'Here is your answer.' }]);
    const output = await loop.run('what is 2+2?');

    expect(output).toBe('Here is your answer.');
    expect(requests).toHaveLength(1);
  });

  test('seeds the conversation with a system prompt and the user task', async () => {
    const { loop, requests } = build([{ content: 'ok' }]);
    await loop.run('count the files');

    const first = requests[0]!;
    expect(first[0]!.role).toBe('system');
    expect(first[1]!.role).toBe('user');
    expect(first[1]!.content).toBe('count the files');
  });

  test('executes a tool call and feeds the result back keyed by the call id', async () => {
    const echo = stubTool('echo', async params => ({ echoed: params.value }));

    const { loop, requests } = build(
      [
        { toolCalls: [{ id: 'call_abc', name: 'echo', arguments: { value: 'ping' } }] },
        { content: 'The tool returned ping.' },
      ],
      { tools: [echo] },
    );

    const output = await loop.run('echo ping');

    expect(output).toBe('The tool returned ping.');
    expect(requests).toHaveLength(2);

    const second = requests[1]!;

    // The assistant turn must preserve the tool_call id.
    const assistant = second.find(message => message.role === 'assistant');
    expect(assistant).toBeDefined();
    const assistantToolCalls = (assistant as any).toolCalls;
    expect(assistantToolCalls[0].id).toBe('call_abc');
    expect(assistantToolCalls[0].name).toBe('echo');

    // The tool turn must reference the same id, otherwise the API rejects the request.
    const toolMessage = second.find(message => message.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect((toolMessage as any).toolCallId).toBe('call_abc');
    expect((toolMessage as any).name).toBe('echo');
    expect((toolMessage as any).content).toContain('ping');
  });

  test('passes tool arguments through to the tool implementation', async () => {
    const received: Array<Record<string, any>> = [];
    const spy = stubTool('spy', async params => {
      received.push(params);
      return { ok: true };
    });

    const { loop } = build(
      [
        { toolCalls: [{ id: 'c1', name: 'spy', arguments: { a: 1, b: 'two' } }] },
        { content: 'done' },
      ],
      { tools: [spy] },
    );

    await loop.run('call spy');
    expect(received).toEqual([{ a: 1, b: 'two' }]);
  });

  test('terminates and returns the summary when the model calls finish', async () => {
    const finish = stubTool('finish', async params => ({ finished: true, summary: params.summary }));

    const { loop, requests } = build(
      [{ toolCalls: [{ id: 'c1', name: 'finish', arguments: { summary: 'work complete' } }] }],
      { tools: [finish] },
    );

    const output = await loop.run('do the thing');
    expect(output).toBe('work complete');
    expect(requests).toHaveLength(1);
  });

  test('reports a failed tool as ERROR and still returns control to the model', async () => {
    const exploding = stubTool('exploding', async () => {
      throw new Error('tool exploded');
    });

    const { loop, requests } = build(
      [
        { toolCalls: [{ id: 'c1', name: 'exploding', arguments: {} }] },
        { content: 'That tool failed.' },
      ],
      { tools: [exploding] },
    );

    const output = await loop.run('try the tool');

    expect(output).toBe('That tool failed.');
    const toolMessage = requests[1]!.find(message => message.role === 'tool') as any;
    expect(toolMessage.content).toContain('ERROR');
    expect(toolMessage.content).toContain('tool exploded');
  });

  test('surfaces an unknown tool call without throwing', async () => {
    const { loop, requests } = build([
      { toolCalls: [{ id: 'c1', name: 'nonexistent', arguments: {} }] },
      { content: 'recovered' },
    ]);

    const output = await loop.run('call a missing tool');
    expect(output).toBe('recovered');
    const toolMessage = requests[1]!.find(message => message.role === 'tool') as any;
    expect(toolMessage.content).toContain('Unknown tool');
  });

  test('calls out an identical repeat instead of re-running it', async () => {
    const failing = stubTool('flaky', async () => {
      throw new Error('nope');
    });

    let invocations = 0;
    const counted = stubTool('counted', async () => {
      invocations++;
      throw new Error('nope');
    });

    const { loop, requests } = build(
      [
        { toolCalls: [{ id: 'c1', name: 'counted', arguments: { a: 1 } }] },
        { toolCalls: [{ id: 'c2', name: 'counted', arguments: { a: 1 } }] },
        { content: 'gave up' },
      ],
      { tools: [counted, failing] },
    );

    const output = await loop.run('retry the same thing');

    expect(output).toBe('gave up');
// The repeat is short-circuited rather than executed again.
expect(invocations).toBe(1);

// Its result is visible in the next request; take the last tool message, since the
// first one belongs to the original failure.
const toolMessages = requests[2]!.filter(message => message.role === 'tool') as any[];
expect(toolMessages).toHaveLength(2);
expect(toolMessages[0]!.content).toBe('ERROR nope');
expect(toolMessages[1]!.content).toContain('already failed');
  });

  test('allows a retry with different arguments', async () => {
    let invocations = 0;
    const counted = stubTool('counted', async params => {
      invocations++;
      if (params.mode === 'bad') {
        throw new Error('nope');
      }
      return { ok: true };
    });

    const { loop } = build(
      [
        { toolCalls: [{ id: 'c1', name: 'counted', arguments: { mode: 'bad' } }] },
        { toolCalls: [{ id: 'c2', name: 'counted', arguments: { mode: 'good' } }] },
        { content: 'recovered' },
      ],
      { tools: [counted] },
    );

    const output = await loop.run('retry with different arguments');
    expect(output).toBe('recovered');
    expect(invocations).toBe(2);
  });

  test('executes multiple tool calls in one turn', async () => {
    const seen: string[] = [];
    const record = (name: string) =>
      stubTool(name, async () => {
        seen.push(name);
        return { ok: true };
      });

    const { loop, requests } = build(
      [
        {
          toolCalls: [
            { id: 'a', name: 'first', arguments: {} },
            { id: 'b', name: 'second', arguments: {} },
          ],
        },
        { content: 'both done' },
      ],
      { tools: [record('first'), record('second')] },
    );

    await loop.run('run both');
    expect(seen).toEqual(['first', 'second']);

    const toolMessages = requests[1]!.filter(message => message.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages.map((m: any) => m.toolCallId)).toEqual(['a', 'b']);
  });

  test('stops at maxSteps instead of looping forever', async () => {
    const tick = stubTool('tick', async () => ({ ok: true }));
    const { loop, requests } = build(
      Array.from({ length: 50 }, (_unused, index) => ({
        toolCalls: [{ id: `c${index}`, name: 'tick', arguments: {} }],
      })),
      { tools: [tick], maxSteps: 3 },
    );

    const output = await loop.run('loop forever');

    expect(requests).toHaveLength(3);
    expect(output).toBe('Agent finished without producing an answer.');
  });

  test('surfaces a provider error instead of throwing', async () => {
    const provider = {
      async generate(): Promise<ModelResponse> {
        throw new Error('provider exploded');
      },
      supportsTools: () => true,
    };
    const agent = new KaizenAgent(provider);
    const loop = new AgentLoop(agent, new ToolRegistry());

    const output = await loop.run('anything');
    expect(output).toBe('Agent finished without producing an answer.');
  });
});