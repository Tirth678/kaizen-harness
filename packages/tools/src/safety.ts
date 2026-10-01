import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface Violation {
  rule: string;
  detail: string;
}

export interface PolicyOptions {
  /** Bypass all rules. Set KZN_ALLOW_DANGEROUS_COMMANDS=1 to enable. */
  allowDangerous?: boolean;
  /** If provided, a command must match at least one pattern to be allowed. */
  allowlist?: RegExp[];
}

export interface Rule {
  name: string;
  pattern: RegExp;
  detail: string;
}

/**
 * Patterns matched against the whole command string. These catch shapes that do not
 * survive splitting on shell operators (notably `curl ... | sh`).
 */
export const BLOCKED_RULES: Rule[] = [
  {
    name: 'remote-code-execution',
    pattern: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i,
    detail: 'piping a downloaded script straight into a shell executes unreviewed remote code',
  },
  {
    name: 'raw-device-write',
    pattern: />\s*\/dev\/(sd|hd|nvme|disk|vd)[a-z0-9]*/i,
    detail: 'redirecting output to a block device destroys data',
  },
  {
    name: 'recursive-root-permissions',
    pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\s+\/(?:\s|$|\*)/,
    detail: 'recursively making the root filesystem world-writable',
  },
  {
    name: 'recursive-root-ownership',
    pattern: /\bchown\s+(?:-[a-zA-Z]+\s+)*\S+\s+\/(?:\s|$|\*)/,
    detail: 'recursively changing ownership of the root filesystem',
  },
  {
    name: 'fork-bomb',
    pattern: /:\s*\(\s*\)\s*\{[^|]*\|[^}]*&[^}]*\}\s*;\s*:/,
    detail: 'fork bomb exhausts process and hangs the machine',
  },
];

/**
 * Matched only at command position within a shell segment, so that mentions of these
 * words inside filenames, quoted strings, or argument data do not trip the policy.
 */
const COMMAND_RULES: Rule[] = [
  {
    name: 'filesystem-format',
    pattern: /^mkfs(\.\w+)?\b/,
    detail: 'mkfs erases the target filesystem',
  },
  {
    name: 'raw-device-write',
    pattern: /^dd\b[^;&]*\bof=\/dev\/(sd|hd|nvme|disk|vd)/,
    detail: 'dd writing directly to a block device destroys data',
  },
];

const COMMAND_PREFIX = String.raw`^(?:sudo\s+|command\s+|exec\s+|env\s+\S+\s+)*`;

const SEGMENT_SPLIT = /(?:\|\||&&|\||;|\n|\r)/;

/** Directories whose recursive deletion takes out the machine. */
const PROTECTED_TARGETS = new Set([
  '/',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib32',
  '/lib64',
  '/opt',
  '/private',
  '/proc',
  '/root',
  '/sbin',
  '/srv',
  '/sys',
  '/usr',
  '/var',
  '/System',
  '/Library',
  '/Applications',
  '/Users',
  '/Volumes',
  '/Windows',
]);

function segments(command: string): string[] {
  return command
    .split(SEGMENT_SPLIT)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
}

function expandPath(target: string): string {
  let expanded = target.replace(/^~(?=$|\/)/, homedir());
  expanded = expanded.replace(/^\$HOME(?=$|\/)/, homedir());
  expanded = expanded.replace(/^\$\{HOME\}(?=$|\/)/, homedir());
  return expanded;
}

/** Extracts the first non-flag argument of an `rm` invocation. */
function rmTarget(segment: string): string | null {
  const match = /^(?:sudo\s+)?rm\b((?:\s+-{1,2}[^\s]+)*)\s*(.*)$/.exec(segment);
  if (!match) {
    return null;
  }

  const rest = (match[2] ?? '').trim();
  if (rest.length === 0) {
    return null;
  }

  const tokens = rest.split(/\s+/);
  const target = tokens.find(token => !token.startsWith('-'));
  return target ?? null;
}

/**
 * Normalizes a deletion target for comparison: strips trailing slashes and glob
 * suffixes so that `/`, `/*`, and `//` all compare equal.
 */
function normalizeTarget(target: string): string {
  return target.replace(/\/+$/, '').replace(/\/?\*+$/, '') || '/';
}

function checkRecursiveRm(segment: string): Violation | null {
  const match = /^(?:sudo\s+)?rm\b((?:\s+-{1,2}[^\s]+)*)/.exec(segment);
  if (!match) {
    return null;
  }

  const flags = match[1] ?? '';
  const recursive = /(^|\s)-[a-zA-Z]*[rR]/.test(flags) || flags.includes('--recursive');
  if (!recursive) {
    return null;
  }

  const target = rmTarget(segment);
  if (target === null) {
    return null;
  }

  const expanded = expandPath(target);
  const absolute = expanded.startsWith('/') ? resolve(expanded) : resolve(process.cwd(), expanded);

  const protectedHit =
    PROTECTED_TARGETS.has(normalizeTarget(expanded)) ||
    PROTECTED_TARGETS.has(normalizeTarget(absolute)) ||
    absolute === resolve(homedir());

  if (protectedHit) {
    return {
      rule: 'recursive-delete-protected-path',
      detail: `recursive delete targeting a protected path: ${target} (resolved: ${absolute})`,
    };
  }

  return null;
}

/**
 * Screens a shell command for destructive operations.
 *
 * This is a footgun catcher, not a security boundary. The patterns are matched
 * textually and can be bypassed by shell expansion, encoding, aliases, or a script
 * that performs the same effect indirectly. Do not rely on it as isolation.
 */
export function evaluateCommand(command: string, options: PolicyOptions = {}): Violation[] {
  if (options.allowDangerous) {
    return [];
  }

  const violations: Violation[] = [];

  if (options.allowlist && options.allowlist.length > 0) {
    const permitted = options.allowlist.some(pattern => pattern.test(command));
    if (!permitted) {
      violations.push({
        rule: 'allowlist',
        detail: 'command does not match the configured allowlist',
      });
    }
  }

  for (const rule of BLOCKED_RULES) {
    if (rule.pattern.test(command)) {
      violations.push({ rule: rule.name, detail: rule.detail });
    }
  }

  for (const segment of segments(command)) {
    for (const rule of COMMAND_RULES) {
      if (new RegExp(COMMAND_PREFIX + rule.pattern.source).test(segment)) {
        violations.push({ rule: rule.name, detail: rule.detail });
      }
    }

    const rmViolation = checkRecursiveRm(segment);
    if (rmViolation) {
      violations.push(rmViolation);
    }
  }

  return violations;
}

export function isDangerousCommand(command: string, options: PolicyOptions = {}): boolean {
  return evaluateCommand(command, options).length > 0;
}

export function bypassEnabled(): boolean {
  return process.env.KZN_ALLOW_DANGEROUS_COMMANDS === '1';
}