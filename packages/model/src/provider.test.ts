import { afterEach, describe, expect, test } from 'bun:test';
import { OpenRouterModelProvider } from './provider';
import type { ModelMessage, ToolDefinition } from './types';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  body: any;
}

function stubFetch(response: unknown, status = 200, statusText = 'OK'): Captured {
  const captured: Captured = { url: '', body: undefined };

  globalThis.fetch = (async (url: string, init: any) => {
    captured.url = String(url);
    captured.body = JSON.parse(init.body);

    const ok = status >= 200 && status < 300;
    // Success is delivered as SSE, which is what the provider now speaks.
    const text = ok ? sseFrom(response) : JSON.stringify(response);

    return {
      ok,
      status,
      statusText,
      body: ok ? streamOf(text) : null,
      json: async () => response,
      text: async () => text,
    } as any;
  }) as any;

  return captured;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/**
 * Stubs a raw SSE body. A plain string is delivered as one read; an array is
 * delivered as separate reads, which is how a frame split across network chunks
 * is reproduced.
 */
function stubRawFetch(body: string | string[], status = 200, statusText = 'OK'): void {
  const parts = typeof body === 'string' ? [body] : body;
  const encoder = new TextEncoder();
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(encoder.encode(part));
        }
        controller.close();
      },
    });

    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      body,
      text: async () => parts.join(''),
    } as any;
  }) as any;
}

/** Builds one SSE payload object, the shape OpenRouter streams. */
function chunk(payload: Record<string, unknown>): Record<string, unknown> {
  return { choices: [{ delta: {}, ...payload }] };
}

function frames(payloads: (string | Record<string, unknown>)[]): string {
  return payloads
    .map(payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
    .join('');
}

/** Re-frames a plain chat-completion payload as the SSE the API actually sends. */
function sseFrom(response: any): string {
  const choice = response?.choices?.[0];
  const frames: string[] = [];

  if (!choice) {
    frames.push(`data: ${JSON.stringify(response)}`);
  } else {
    const delta: Record<string, unknown> = {};
    if (choice.message?.content) delta.content = choice.message.content;
    if (choice.message?.tool_calls?.length) {
      delta.tool_calls = choice.message.tool_calls.map((call: any, index: number) => ({
        index,
        id: call.id,
        type: 'function',
        function: call.function,
      }));
    }

    frames.push(`data: ${JSON.stringify({ choices: [{ delta }] })}`);
    frames.push(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: choice.finish_reason }] })}`
    );
  }

  frames.push('data: [DONE]');
  return `${frames.join('\n\n')}\n\n`;
}

const provider = () =>
  new OpenRouterModelProvider({ apiKey: 'test-key', model: 'test/model', maxTokens: 512 });

const tools: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      path: { type: 'string', description: 'Path to read', required: true },
      encoding: { type: 'string', description: 'Encoding', required: false },
    },
  },
];

const textResponse = {
  choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
};

const toolCallResponse = {
  choices: [
    {
      message: {
        content: '',
        tool_calls: [
          {
            id: 'call_xyz',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
};

describe('tool schema serialization', () => {
  test('strips property-level required booleans and emits a top-level array', async () => {
    // This is the exact shape OpenRouter rejected with
    // "True is not of type 'array'" before the fix.
    const captured = stubFetch(textResponse);
    await provider().generate([{ role: 'user', content: 'hi' }], tools);

    const parameters = captured.body.tools[0].function.parameters;
    expect(parameters.type).toBe('object');
    expect(Array.isArray(parameters.required)).toBe(true);
    expect(parameters.required).toEqual(['path']);

    for (const spec of Object.values<any>(parameters.properties)) {
      expect('required' in spec).toBe(false);
    }
    expect(parameters.properties.path).toEqual({ type: 'string', description: 'Path to read' });
  });

  test('sets tool_choice only when tools are supplied', async () => {
    const withTools = stubFetch(textResponse);
    await provider().generate([{ role: 'user', content: 'hi' }], tools);
    expect(withTools.body.tool_choice).toBe('auto');

    const withoutTools = stubFetch(textResponse);
    await provider().generate([{ role: 'user', content: 'hi' }]);
    expect(withoutTools.body.tools).toBeUndefined();
    expect(withoutTools.body.tool_choice).toBeUndefined();
  });
});

describe('message serialization', () => {
  test('serializes assistant tool calls with stringified arguments', async () => {
    const captured = stubFetch(textResponse);
    const messages: ModelMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'read a.txt' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.txt' } }],
      },
    ];
    await provider().generate(messages);

    const assistant = captured.body.messages[2];
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls).toHaveLength(1);
    expect(assistant.tool_calls[0].id).toBe('call_1');
    expect(assistant.tool_calls[0].type).toBe('function');
    expect(assistant.tool_calls[0].function.name).toBe('read_file');
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ path: 'a.txt' });
  });

  test('serializes a tool result with tool_call_id', async () => {
    const captured = stubFetch(textResponse);
    const messages: ModelMessage[] = [
      { role: 'user', content: 'read a.txt' },
      {
        role: 'tool',
        content: 'OK {"content":"hi"}',
        toolCallId: 'call_1',
        name: 'read_file',
      },
    ];
    await provider().generate(messages);

    const toolMessage = captured.body.messages[1];
    expect(toolMessage.role).toBe('tool');
    expect(toolMessage.tool_call_id).toBe('call_1');
    expect(toolMessage.content).toBe('OK {"content":"hi"}');
  });

  test('omits tool_calls when the assistant made none', async () => {
    const captured = stubFetch(textResponse);
    await provider().generate([{ role: 'assistant', content: 'plain answer' }]);
    expect(captured.body.messages[0].tool_calls).toBeUndefined();
  });
});

describe('response parsing', () => {
  test('parses text responses', async () => {
    stubFetch(textResponse);
    const response = await provider().generate([{ role: 'user', content: 'hi' }]);
    expect(response.content).toBe('hello');
    expect(response.toolCalls).toBeUndefined();
  });

  test('parses tool calls and decodes arguments', async () => {
    stubFetch(toolCallResponse);
    const response = await provider().generate([{ role: 'user', content: 'hi' }]);
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0]!.id).toBe('call_xyz');
    expect(response.toolCalls![0]!.name).toBe('read_file');
    expect(response.toolCalls![0]!.arguments).toEqual({ path: 'a.txt' });
  });

  test('falls back to a synthetic id when the provider omits one', async () => {
    stubFetch({
      choices: [
        {
          message: { content: '', tool_calls: [{ function: { name: 'f', arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const response = await provider().generate([{ role: 'user', content: 'hi' }]);
    expect(response.toolCalls![0]!.id).toBe('call_0');
  });

  test('treats malformed JSON arguments as empty rather than throwing', async () => {
    stubFetch({
      choices: [
        {
          message: { content: '', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{oops' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const response = await provider().generate([{ role: 'user', content: 'hi' }]);
    expect(response.toolCalls![0]!.arguments).toEqual({});
  });

  test('handles a null content field', async () => {
    stubFetch({ choices: [{ message: { content: null }, finish_reason: 'stop' }] });
    const response = await provider().generate([{ role: 'user', content: 'hi' }]);
    expect(response.content).toBe('');
  });
});

describe('error handling', () => {
  test('includes the API error message and status', async () => {
    stubFetch({ error: { message: 'Invalid JSON schema' } }, 400, 'Bad Request');
    await expect(provider().generate([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /400.*Invalid JSON schema/,
    );
  });

  test('throws when the response has no choices', async () => {
    stubFetch({ choices: [] });
    await expect(provider().generate([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /No response from model/,
    );
  });

  test('requires an API key', () => {
    const previous = process.env.SK_OR_V1_KEY;
    delete process.env.SK_OR_V1_KEY;
    try {
      expect(() => new OpenRouterModelProvider()).toThrow(/API key is required/);
    } finally {
      if (previous !== undefined) {
        process.env.SK_OR_V1_KEY = previous;
      }
    }
  });
});
describe('streaming', () => {
  test('requests stream:true', async () => {
    const captured = stubFetch(textResponse);
    // An async generator is lazy: it must be consumed to reach the request.
    for await (const _ of provider().generateStream([{ role: 'user', content: 'hi' }])) {
      void _;
    }
    expect(captured.body.stream).toBe(true);
  });

  test('yields text deltas before the complete event', async () => {
    stubRawFetch(frames([
      chunk({ delta: { content: 'Hel' } }),
      chunk({ delta: { content: 'lo ' } }),
      chunk({ delta: { content: 'world' }, finish_reason: 'stop' }),
      '[DONE]',
    ]));

    const deltas: string[] = [];
    let complete;
    for await (const event of provider().generateStream([{ role: 'user', content: 'hi' }])) {
      if (event.type === 'text') deltas.push(event.delta);
      else complete = event.response;
    }

    expect(deltas).toEqual(['Hel', 'lo ', 'world']);
    expect(complete?.content).toBe('Hello world');
    expect(complete?.finishReason).toBe('stop');
  });

  test('reassembles tool call argument fragments', async () => {
    stubRawFetch(frames([
      chunk({ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }),
      chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }),
      chunk({ delta: {}, finish_reason: 'tool_calls' }),
      '[DONE]',
    ]));

    let complete;
    for await (const event of provider().generateStream([{ role: 'user', content: 'hi' }])) {
      if (event.type === 'complete') complete = event.response;
    }

    expect(complete?.toolCalls).toHaveLength(1);
    expect(complete?.toolCalls?.[0]).toMatchObject({
      id: 'call_1',
      name: 'read_file',
      arguments: { path: 'a.txt' },
    });
  });

  test('keeps parallel tool calls ordered by index', async () => {
    stubRawFetch(frames([
      chunk({ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'second', arguments: '{}' } }] } }),
      chunk({ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'first', arguments: '{}' } }] } }),
      '[DONE]',
    ]));

    let complete;
    for await (const event of provider().generateStream([{ role: 'user', content: 'hi' }])) {
      if (event.type === 'complete') complete = event.response;
    }

    expect(complete?.toolCalls?.map(c => c.id)).toEqual(['a', 'b']);
  });

  test('buffers a frame split across two reads', async () => {
    const all = frames([chunk({ delta: { content: 'split' } }), '[DONE]']);
    const cut = Math.floor(all.length / 2);
    stubRawFetch([all.slice(0, cut), all.slice(cut)]);

    let content = '';
    for await (const event of provider().generateStream([{ role: 'user', content: 'hi' }])) {
      if (event.type === 'text') content += event.delta;
    }

    expect(content).toBe('split');
  });

  test('tolerates CRLF frame separators and comment lines', async () => {
    stubRawFetch([
      ': keep-alive\r\n\r\n',
      `data: ${JSON.stringify(chunk({ delta: { content: 'ok' } }))}\r\n\r\n`,
      'data: [DONE]\r\n\r\n',
    ]);

    let content = '';
    for await (const event of provider().generateStream([{ role: 'user', content: 'hi' }])) {
      if (event.type === 'text') content += event.delta;
    }

    expect(content).toBe('ok');
  });

  test('surfaces an API error instead of reading the body as a stream', async () => {
    stubRawFetch([JSON.stringify({ error: { message: 'Rate limited' } })], 429, 'Too Many Requests');

    await expect(
      (async () => {
        for await (const _ of provider().generateStream([{ role: 'user', content: 'hi' }])) {
          void _;
        }
      })(),
    ).rejects.toThrow(/429.*Rate limited/);
  });

  test('reports an aborted request as an abort, not a generic failure', async () => {
    const controller = new AbortController();
    globalThis.fetch = (async () => {
      controller.abort();
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }) as any;

    await expect(
      (async () => {
        for await (const _ of provider().generateStream([{ role: 'user', content: 'hi' }], undefined, {
          signal: controller.signal,
        })) {
          void _;
        }
      })(),
    ).rejects.toThrow(/Request aborted/);
  });
});
