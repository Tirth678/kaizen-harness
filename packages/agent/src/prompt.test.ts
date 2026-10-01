import { describe, expect, test } from 'bun:test';
import { buildSystemPrompt } from './prompt';

describe('buildSystemPrompt', () => {
  test('interpolates the model id', () => {
    const prompt = buildSystemPrompt({ model: 'some/model-id' });
    expect(prompt).toContain('some/model-id');
  });

  test('lists the exact tools the agent was given', () => {
    const prompt = buildSystemPrompt({
      model: 'test/model',
      toolNames: ['read_file', 'write_file', 'run_command', 'web_search', 'finish'],
    });

    for (const name of ['read_file', 'write_file', 'run_command', 'web_search', 'finish']) {
      expect(prompt).toContain(name);
    }
  });

  test('does not advertise a shell tool that does not exist', () => {
    const prompt = buildSystemPrompt({
      model: 'test/model',
      toolNames: ['read_file', 'run_command', 'finish'],
    });

    // `shell` appears only as a callout of what NOT to call.
    const listing = prompt.slice(
      prompt.indexOf('### Available tools'),
      prompt.indexOf('### Before changing code'),
    );
    expect(listing).not.toContain('- `shell`');
    expect(listing).toContain('no others');
  });

  test('handles an empty tool set without listing a bogus tool', () => {
    const prompt = buildSystemPrompt({ model: 'test/model', toolNames: [] });
    expect(prompt).toContain('none registered');
  });

  test('handles an omitted tool set', () => {
    const prompt = buildSystemPrompt({ model: 'test/model' });
    expect(prompt).toContain('none registered');
  });

  test('states the finish requirement', () => {
    const prompt = buildSystemPrompt({ model: 'test/model' });
    expect(prompt).toContain('finish');
    expect(prompt).toContain('only way to end a run');
  });

  test('documents the command safety policy', () => {
    const prompt = buildSystemPrompt({ model: 'test/model' });
    expect(prompt).toContain('safety policy');
  });
});