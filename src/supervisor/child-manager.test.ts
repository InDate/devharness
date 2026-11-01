import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as url from 'url';
import { ChildManager } from './child-manager.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, '__fixtures__', 'test-child.mjs');

/** Resolves once the fixture's signal handlers are in place: it writes its first output only after them. */
const ready = ({ stdout }: { stdout: NodeJS.ReadableStream }) =>
  new Promise<void>(resolve => stdout.once('data', () => resolve()));

describe('ChildManager (real subprocess)', () => {
  it('spawns a child and kill() resolves once it exits on SIGTERM', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: [],
      cwd: __dirname,
      killGraceMs: 3000,
    });

    manager.spawn();
    expect(manager.isRunning()).toBe(true);

    await manager.kill();
    expect(manager.isRunning()).toBe(false);
  }, 10000);

  it('escalates to SIGKILL after the grace period for a child that ignores SIGTERM', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: ['ignore-sigterm'],
      cwd: __dirname,
      killGraceMs: 300, // short for test speed
    });

    await ready(manager.spawn());
    const start = Date.now();
    await manager.kill();
    const elapsed = Date.now() - start;

    expect(manager.isRunning()).toBe(false);
    // Should have waited roughly the grace period before SIGKILL landed, not exited instantly.
    expect(elapsed).toBeGreaterThanOrEqual(250);
  }, 10000);

  it('fires onExit for a child that crashes on its own', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: ['crash'],
      cwd: __dirname,
    });

    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      manager.onExit((info) => resolve(info));
      manager.spawn();
    });

    expect(exitInfo.code).toBe(1);
  }, 10000);

  it('suspend() signals the child and resolves once it has released and exited', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: [],
      cwd: __dirname,
      suspendGraceMs: 3000,
    });

    await ready(manager.spawn());

    await manager.suspend();
    expect(manager.isRunning()).toBe(false);
  }, 10000);

  it('suspend() escalates to a kill for a child that never finishes releasing', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: ['ignore-suspend'],
      cwd: __dirname,
      suspendGraceMs: 300,
      killGraceMs: 300,
    });

    await ready(manager.spawn());

    await manager.suspend();
    expect(manager.isRunning()).toBe(false);
  }, 10000);

  it('suspend() on an already-dead child resolves immediately without throwing', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: ['crash'],
      cwd: __dirname,
    });

    await new Promise<void>((resolve) => {
      manager.onExit(() => resolve());
      manager.spawn();
    });

    await expect(manager.suspend()).resolves.toBeUndefined();
  }, 10000);

  it('kill() on an already-dead child resolves immediately without throwing', async () => {
    const manager = new ChildManager({
      execPath: process.execPath,
      scriptPath: FIXTURE_PATH,
      extraArgs: ['crash'],
      cwd: __dirname,
    });

    await new Promise<void>((resolve) => {
      manager.onExit(() => resolve());
      manager.spawn();
    });

    await expect(manager.kill()).resolves.toBeUndefined();
  }, 10000);
});
