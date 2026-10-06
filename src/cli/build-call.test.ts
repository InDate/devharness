/**
 * The tool call each CLI verb stands for, taken from argv without a session.
 *
 * `runCli` reaches a socket, so the mapping from words to tool arguments is
 * tested here through `parseArgs` + `buildCall` alone.
 */

import { describe, it, expect } from 'vitest';
import { parseArgs, buildCall } from './index.js';

function call(argv: string[]) {
  return buildCall(parseArgs(argv));
}

describe('issue verbs', () => {
  it('files a feature from a title alone, with no body key', () => {
    expect(call(['feature', 'Add a --label flag'])).toEqual({
      tool: 'issues',
      args: {
        action: 'create',
        type: 'feature',
        title: 'Add a --label flag',
        includeSequence: false,
      },
    });
  });

  it('joins the remaining words into the body', () => {
    expect(call(['bug', 'Sequence click misses', 'Steps:', '1. open', '2. click'])).toEqual({
      tool: 'issues',
      args: {
        action: 'create',
        type: 'bug',
        title: 'Sequence click misses',
        body: 'Steps: 1. open 2. click',
        includeSequence: false,
      },
    });
  });

  it('keeps flag-shaped words in the body after --', () => {
    const built = call(['bug', 'Output ignores a flag', '--', 'passing --json prints nothing']);
    expect(built).toEqual({
      tool: 'issues',
      args: {
        action: 'create',
        type: 'bug',
        title: 'Output ignores a flag',
        body: 'passing --json prints nothing',
        includeSequence: false,
      },
    });
  });

  it('returns usage text when no title is given', () => {
    expect(call(['bug'])).toBe('Usage: devharness bug <title> [body]');
    expect(call(['feature'])).toBe('Usage: devharness feature <title> [body]');
  });
});

describe('devharness bench', () => {
  it('opens on a three-word connection of its own, whatever session is named', () => {
    expect(call(['bench', 'editor-typing', 'http://localhost:7788/', '--session=b1afdd24'])).toEqual({
      tool: 'bench',
      args: { action: 'start', connection: 'bench-cli-browser', sequence: 'editor-typing', url: 'http://localhost:7788/' },
    });
  });

  it('opens on the connection named with --connection', () => {
    expect((call(['bench', '--connection=app-under-test']) as { args: Record<string, unknown> }).args).toMatchObject({ connection: 'app-under-test' });
  });
});
