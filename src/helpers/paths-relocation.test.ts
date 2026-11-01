/**
 * The root-bound resource registry and the `relocateRoot` transaction that
 * `config({ action: 'useLocal', path: X })` drives: every registered
 * resource's `veto()` runs first, a non-null reason rejects with the root and
 * every resource untouched, and otherwise the root moves and each resource's
 * `rebind(root)` runs in registration order. A second registration under a
 * name replaces the first.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getOutputPath, resolveStateDir, registerRootBound, unregisterRootBound, relocateRoot } from './paths.js';

let rootA: string;
let rootB: string;

const register = registerRootBound;
const unregister = unregisterRootBound;
const relocate = relocateRoot;

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), 'devharness-paths-reloc-a-'));
  rootB = mkdtempSync(join(tmpdir(), 'devharness-paths-reloc-b-'));
});

afterEach(() => {
  // A resource registered by one test would otherwise rebind or veto a later test's relocation.
  for (const name of ['probe-a', 'probe-b', 'probe-veto', 'probe-x']) unregister(name);
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

describe('relocateRoot as a transaction', () => {
  it('with no veto: updates the root and rebinds every registered resource, in registration order, with the new root', async () => {
    const calls: string[] = [];
    register({ name: 'probe-a', rebind: (root) => { calls.push(`a:${root}`); } });
    register({ name: 'probe-b', rebind: (root) => { calls.push(`b:${root}`); } });

    await relocate(rootB);

    const expectedRoot = resolveStateDir(rootB);
    expect(calls).toEqual([`a:${expectedRoot}`, `b:${expectedRoot}`]);
    expect(getOutputPath()).toBe(expectedRoot);
  });

  it('one veto: the root is left unchanged, no resource is rebound, and the rejection names the vetoing resource', async () => {
    await relocate(rootA); // establish a known baseline root
    const baselineRoot = getOutputPath();

    const rebindSpy = vi.fn();
    register({ name: 'probe-a', rebind: rebindSpy });
    register({
      name: 'probe-veto',
      rebind: vi.fn(),
      veto: () => 'managed server "fitness-demo" is running and cannot move its log files',
    });

    await expect(relocate(rootB)).rejects.toThrow(/probe-veto/);
    await expect(relocate(rootB)).rejects.toThrow(/fitness-demo/);

    expect(rebindSpy).not.toHaveBeenCalled();
    expect(getOutputPath()).toBe(baselineRoot);
  });

  it('runs a relocation through a resource whose veto returns null', async () => {
    register({ name: 'probe-a', rebind: vi.fn(), veto: () => null });

    await expect(relocate(rootB)).resolves.toBeUndefined();
  });
});

describe('registry contract', () => {
  it('an unregistered resource does not rebind on a later relocation', async () => {
    const rebindSpy = vi.fn();
    register({ name: 'probe-a', rebind: rebindSpy });
    unregister('probe-a');

    await relocate(rootB);

    expect(rebindSpy).not.toHaveBeenCalled();
  });

  it('re-registering the same name replaces the earlier registration (last write wins), not both firing', async () => {
    const firstSpy = vi.fn();
    const secondSpy = vi.fn();
    register({ name: 'probe-x', rebind: firstSpy });
    register({ name: 'probe-x', rebind: secondSpy }); // same name, no unregister in between

    await relocate(rootB);

    expect(firstSpy).not.toHaveBeenCalled();
    expect(secondSpy).toHaveBeenCalledTimes(1);
  });

  it('a veto from the replacement registration is the one that applies, not the replaced original', async () => {
    register({ name: 'probe-x', rebind: vi.fn(), veto: () => null });
    register({ name: 'probe-x', rebind: vi.fn(), veto: () => 'replacement vetoes' });

    await expect(relocate(rootB)).rejects.toThrow(/probe-x/);
  });
});
