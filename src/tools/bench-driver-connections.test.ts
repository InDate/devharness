/**
 * The `run` a bench issues for the sequence it holds.
 *
 * A sequence carries the connection references it was recorded against. One
 * recorded against a single browser is rebound onto the bench's tab, or the
 * play drives a browser the bench does not show. One spanning two browsers
 * keeps both: rebinding the other browser onto the bench's tab sends that
 * browser's steps - its logins, its cookies - to the wrong page (#105).
 */
import { describe, it, expect } from 'vitest';
import { createSequenceDriver } from '../bench-mode/sequence-driver.js';

function driverHolding(commands: Array<{ tool: string; params: Record<string, any> }>, extra: Record<string, any> = {}) {
  const sequence = { id: 's', name: 'walk', commands, ...extra };
  const runs: Array<Record<string, any>> = [];
  const recorder = {
    getActiveSequence: () => null,
    getSequence: (id: string) => (id === 's' ? sequence : undefined),
    listSequences: () => [sequence],
    listSavedSequencesOnDisk: async () => [],
  } as any;
  const driver = createSequenceDriver(recorder, async (tool: string, params: Record<string, any>) => {
    if (tool === 'replay' && params.action === 'run') runs.push(params);
    return { content: [{ type: 'text', text: 'ok' }] };
  }, () => []);
  return { driver, runs };
}

describe('the connections a bench play binds', () => {
  it('leaves both browsers of a two-browser sequence bound to themselves, with the bench on one of them', async () => {
    const { driver, runs } = driverHolding([
      { tool: 'input', params: { action: 'click', selector: '#unlock', connection: 'messaging-host-root' } },
      { tool: 'navigate', params: { action: 'goto', url: 'http://localhost:8801/join', connection: 'messaging-person-one' } },
    ]);

    await driver.start('walk', 'messaging-person-one');
    await driver.finish();

    expect(runs).toHaveLength(1);
    expect(runs[0].connections).toBeUndefined();
  });

  it('counts a browser the sequence only declares in requiredConnections', async () => {
    const { driver, runs } = driverHolding(
      [{ tool: 'input', params: { action: 'click', selector: '#open', connection: 'messaging-person-one' } }],
      { requiredConnections: [{ connection: 'messaging-host-root', forceNewInstance: true }] },
    );

    await driver.start('walk', 'messaging-person-one');
    await driver.finish();

    expect(runs[0].connections).toBeUndefined();
  });

  it('rebinds a one-browser sequence recorded elsewhere onto the bench tab', async () => {
    const { driver, runs } = driverHolding([
      { tool: 'input', params: { action: 'click', selector: '#a', connection: 'recorded-tab' } },
      { tool: 'input', params: { action: 'click', selector: '#b', connection: 'recorded-tab' } },
    ]);

    await driver.start('walk', 'bench-tab');
    await driver.finish();

    expect(runs[0].connections).toEqual({ 'recorded-tab': 'bench-tab' });
  });
});

describe('the env file a bench play reads', () => {
  it('carries the env file set on the bench into the run', async () => {
    const { driver, runs } = driverHolding([{ tool: 'input', params: { action: 'click', selector: '#a' } }]);

    await driver.start('walk', 'bench-tab');
    driver.setEnvFile('keel/local.env');
    await driver.finish();

    expect(runs[0].envFile).toBe('keel/local.env');
  });

  it('names no env file once it is cleared, so the run reads .devharness/sequences.env', async () => {
    const { driver, runs } = driverHolding([{ tool: 'input', params: { action: 'click', selector: '#a' } }]);

    await driver.start('walk', 'bench-tab');
    driver.setEnvFile('keel/local.env');
    driver.setEnvFile('');
    await driver.finish();

    expect(runs[0]).not.toHaveProperty('envFile');
  });
});
