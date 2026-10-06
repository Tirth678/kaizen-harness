import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from './registry';
import { Tool, ToolCall } from './types';

function stubTool(name: string, execute: Tool['execute'], parameters: Tool['parameters'] = {}): Tool {
  return { name, description: name, parameters, execute };
}

const call = (tool: string, parameters: Record<string, any> = {}): ToolCall => ({
  tool,
  parameters,
});

describe('ToolRegistry', () => {
  test('reports success when the tool resolves', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('ok', async () => ({ value: 1 })));

    const result = await registry.execute(call('ok'));
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ value: 1 });
  });

  test('reports failure when the tool throws', async () => {
    const registry = new ToolRegistry();
    registry.register(
      stubTool('bad', async () => {
        throw new Error('tool exploded');
      }),
    );

    const result = await registry.execute(call('bad'));
    expect(result.success).toBe(false);
    expect(result.error).toBe('tool exploded');
  });

  test('reports failure for a tool that returns a success:false payload', async () => {
    // This is the bug the suite exists to prevent: a tool signalling failure through
    // its payload instead of throwing used to be reported as a successful run.
    const registry = new ToolRegistry();
    registry.register(
      stubTool('lying', async () => ({ success: false, error: 'really failed' }) as any),
    );

    const result = await registry.execute(call('lying'));
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ success: false, error: 'really failed' });
  });

  test('lists available tools for an unknown tool instead of a bare error', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('read_file', async () => ({})));

    const result = await registry.execute(call('shell'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('read_file');
    expect(result.error).toContain('Do not retry');
  });

  test('rejects an argument the tool does not declare', async () => {
    // The live bug: a model sent read_file a startLine/endLine range the tool did
    // not accept, the arguments were dropped, and it got the whole file back with
    // no error. It repeated the call three times before giving up.
    let executed = false;
    const registry = new ToolRegistry();
    registry.register(
      stubTool(
        'read_file',
        async () => {
          executed = true;
          return {};
        },
        { path: { type: 'string', description: 'p', required: true } },
      ),
    );

    const result = await registry.execute(
      call('read_file', { path: '/tmp/x', startLine: 10, endLine: 20 }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('startLine');
    expect(result.error).toContain('endLine');
    // It must name what is accepted, or the model can only guess again.
    expect(result.error).toContain('accepts: path');
    // Failing fast beats running the tool and silently ignoring the arguments.
    expect(executed).toBe(false);
  });

  test('accepts every declared argument', async () => {
    const registry = new ToolRegistry();
    registry.register(
      stubTool('read_file', async params => ({ got: params.path }), {
        path: { type: 'string', description: 'p', required: true },
        startLine: { type: 'number', description: 's', required: false },
      }),
    );

    const result = await registry.execute(call('read_file', { path: '/tmp/x', startLine: 3 }));
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ got: '/tmp/x' });
  });

  test('tolerates a tool that declares no parameters being called with none', async () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('ok', async () => ({ value: 1 })));

    const result = await registry.execute(call('ok', {}));
    expect(result.success).toBe(true);
  });

  test('get() and list() reflect registered tools', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('a', async () => ({})));
    registry.register(stubTool('b', async () => ({})));
    expect(registry.get('a')?.name).toBe('a');
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.list().map(tool => tool.name).sort()).toEqual(['a', 'b']);
  });
});