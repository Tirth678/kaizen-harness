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
describe('buildSystemPrompt environment', () => {
  test('names the working directory when given one', () => {
    const prompt = buildSystemPrompt({
      model: 'test/model',
      workingDirectory: '/srv/app',
    });

    expect(prompt).toContain('/srv/app');
  });

  test('omits working directory guidance when not given one', () => {
    const prompt = buildSystemPrompt({ model: 'test/model' });

    expect(prompt).not.toContain('Your working directory is');
  });

  test('states the step budget when given one', () => {
    const prompt = buildSystemPrompt({ model: 'test/model', maxSteps: 25 });

    expect(prompt).toContain('25 model calls');
  });

  test('omits a numeric budget when not given one', () => {
    const prompt = buildSystemPrompt({ model: 'test/model' });

    expect(prompt).not.toMatch(/\*\*\d+ model calls\*\*/);
  });

  test('tells the model to skip build output', () => {
    // An observed run spent three of its reads on dist/*.d.ts files.
    const prompt = buildSystemPrompt({ model: 'test/model' });

    expect(prompt).toMatch(/Not worth reading/);
    expect(prompt).toContain('dist/');
    expect(prompt).toContain('already read this run');
  });

  test('makes running its own tests a requirement of finishing', () => {
    const prompt = buildSystemPrompt({ model: 'test/model' });

    expect(prompt).toMatch(/Run your own checks before finishing/);
    expect(prompt).toMatch(/Untested test code is not a result/);
  });
});
