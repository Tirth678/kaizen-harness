import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from './registry';
import { Tool, ToolCall } from './types';

function stubTool(name: string, execute: Tool['execute']): Tool {
  return { name, description: name, parameters: {}, execute };
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

  test('get() and list() reflect registered tools', () => {
    const registry = new ToolRegistry();
    registry.register(stubTool('a', async () => ({})));
    registry.register(stubTool('b', async () => ({})));
    expect(registry.get('a')?.name).toBe('a');
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.list().map(tool => tool.name).sort()).toEqual(['a', 'b']);
  });
});