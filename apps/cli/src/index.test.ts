import { describe, expect, test } from 'bun:test';
import pkg from '../package.json';
import { VERSION, printHelp } from './index';

/**
 * VERSION is a literal in index.ts rather than an import, because the bundled CLI
 * cannot reliably resolve package.json at runtime. This test is what stops the
 * two from drifting apart.
 */
describe('cli version', () => {
  test('matches the published package version', () => {
    expect(VERSION).toBe(pkg.version);
  });
});

describe('printHelp', () => {
  test('documents the version flags it handles', () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line?: unknown) => void lines.push(String(line));
    try {
      printHelp();
    } finally {
      console.log = log;
    }

    const output = lines.join('\n');
    expect(output).toContain('--version');
    expect(output).toContain('-v');
  });
});