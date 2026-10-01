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
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      json: async () => response,
    } as any;
  }) as any;

  return captured;
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