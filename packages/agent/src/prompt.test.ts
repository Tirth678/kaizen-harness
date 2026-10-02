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
  });

  test('does not contradict the loop on how a run may end', () => {
    const prompt = buildSystemPrompt({ model: 'test/model' });

    // KaizenAgent.decide() treats a plain-text reply with no tool calls as a
    // finish. The prompt must not claim otherwise or the model is misled.
    expect(prompt).not.toContain('only way to end a run');
    expect(prompt).not.toContain('unfinished run');
    expect(prompt).toContain('treated as your final answer');
  });

  test('documents the command safety policy', () => {
    const prompt = buildSystemPrompt({ model: 'test/model' });
    expect(prompt).toContain('safety policy');
  });
});