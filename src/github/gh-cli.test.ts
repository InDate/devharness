// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runGh, runGhJson, setGhSpawnForTests, GhError, DEFAULT_GH_TIMEOUT_MS } from './gh-cli.js';

/** A child that behaves however the test needs, recording what was done to it. */
function fakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdinEnded = false;
  child.written = '';
  child.signals = [] as string[];
  child.stdin = {
    write: (s: string) => { child.written += s; },
    end: () => { child.stdinEnded = true; },
  };
  child.kill = (sig: string) => { child.signals.push(sig); return true; };
  return child;
}

function useChild(child: any, capture?: (args: string[], opts: any) => void) {
  setGhSpawnForTests(((_cmd: string, args: string[], opts: any) => {
    capture?.(args, opts);
    return child;
  }) as any);
  return child;
}

afterEach(() => {
  setGhSpawnForTests(null);
  vi.useRealTimers();
});

describe('runGh', () => {
  it('resolves stdout on a clean exit', async () => {
    const child = useChild(fakeChild());
    const promise = runGh(['issue', 'list']);
    child.stdout.emit('data', '[]');
    child.emit('close', 0);
    await expect(promise).resolves.toBe('[]');
  });

  it('closes stdin immediately, before anything can block', async () => {
    const child = useChild(fakeChild());
    const promise = runGh(['issue', 'create'], { stdin: 'body text' });
    // Asserted before the process has exited: a prompting gh must already
    // have seen EOF by now, not after we finish reading its output.
    expect(child.stdinEnded).toBe(true);
    expect(child.written).toBe('body text');
    child.emit('close', 0);
    await promise;
  });

  it('disables the pager and prompts, the two hang vectors', async () => {
    let seen: any;
    const child = useChild(fakeChild(), (_args, opts) => { seen = opts; });
    const promise = runGh(['repo', 'view']);
    expect(seen.env.GH_PROMPT_DISABLED).toBe('1');
    expect(seen.env.GH_PAGER).toBe('cat');
    expect(seen.env.GH_NO_UPDATE_NOTIFIER).toBe('1');
    child.emit('close', 0);
    await promise;
  });

  it('rejects with GH_TIMEOUT when the child never exits, then escalates to SIGKILL', async () => {
    vi.useFakeTimers();
    const child = useChild(fakeChild());
    const promise = runGh(['issue', 'list']);
    const assertion = expect(promise).rejects.toMatchObject({ code: 'GH_TIMEOUT' });

    // The child emits nothing, ever - the bug-003 shape.
    await vi.advanceTimersByTimeAsync(DEFAULT_GH_TIMEOUT_MS + 1);
    await assertion;
    expect(child.signals).toEqual(['SIGTERM']);

    await vi.advanceTimersByTimeAsync(2_001);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports GH_NOT_INSTALLED when gh is missing', async () => {
    const child = useChild(fakeChild());
    const promise = runGh(['issue', 'list']);
    const err = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    child.emit('error', err);
    await expect(promise).rejects.toMatchObject({ code: 'GH_NOT_INSTALLED' });
  });

  it('reports GH_NOT_AUTHENTICATED from stderr', async () => {
    const child = useChild(fakeChild());
    const promise = runGh(['issue', 'list']);
    child.stderr.emit('data', 'gh: To get started with GitHub CLI, please run: gh auth login\n');
    child.emit('close', 4);
    await expect(promise).rejects.toMatchObject({ code: 'GH_NOT_AUTHENTICATED' });
  });

  it('reports GH_NO_REPO when the directory has no GitHub remote', async () => {
    const child = useChild(fakeChild());
    const promise = runGh(['issue', 'list']);
    child.stderr.emit('data', 'none of the git remotes configured for this repository point to a known GitHub host\n');
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({ code: 'GH_NO_REPO' });
  });

  it('falls back to GH_FAILED and keeps stderr for the message', async () => {
    const child = useChild(fakeChild());
    const promise = runGh(['issue', 'view', '9999']);
    child.stderr.emit('data', 'GraphQL: Could not resolve to an Issue with the number of 9999.\n');
    child.emit('close', 1);
    await expect(promise).rejects.toMatchObject({
      code: 'GH_FAILED',
      stderr: expect.stringContaining('Could not resolve'),
    });
  });

  it('rejects rather than throwing when stdout is not JSON', async () => {
    const child = useChild(fakeChild());
    const promise = runGhJson(['issue', 'list']);
    child.stdout.emit('data', 'not json at all');
    child.emit('close', 0);
    await expect(promise).rejects.toBeInstanceOf(GhError);
  });
});

describe('runGh against a real process', () => {
  // The injected tests prove classification; only this one proves the actual
  // spawn path cannot hang.
  it('kills a real gh that never exits', async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), 'gh-stub-'));
    const stub = join(dir, 'gh');
    await fsp.writeFile(stub, '#!/bin/sh\nsleep 300\n', { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath}`;

    try {
      const started = Date.now();
      await expect(runGh(['issue', 'list'], { timeoutMs: 750 }))
        .rejects.toMatchObject({ code: 'GH_TIMEOUT' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      process.env.PATH = originalPath;
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
