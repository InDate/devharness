import { describe, it, expect } from 'vitest';
import {
  readSupervisorSessionConfig,
  idleCheckIntervalMs,
  DEFAULT_IDLE_SUSPEND_MINUTES,
  DEFAULT_CLIENT_POLL_SECONDS,
} from './idle-config.js';

const NO_FILE = () => {
  throw new Error('ENOENT');
};

describe('readSupervisorSessionConfig', () => {
  it('falls back to defaults with no config file', () => {
    const config = readSupervisorSessionConfig({ configPath: '/nope.json', env: {}, readFile: NO_FILE });
    expect(config).toEqual({
      idleSuspendMinutes: DEFAULT_IDLE_SUSPEND_MINUTES,
      clientPollSeconds: DEFAULT_CLIENT_POLL_SECONDS,
    });
  });

  it('reads the session section from the config file', () => {
    const config = readSupervisorSessionConfig({
      configPath: '/config.json',
      env: {},
      readFile: () => JSON.stringify({ session: { idleSuspendMinutes: 30, clientPollSeconds: 15 } }),
    });
    expect(config).toEqual({ idleSuspendMinutes: 30, clientPollSeconds: 15 });
  });

  it('lets the environment override the file', () => {
    const config = readSupervisorSessionConfig({
      configPath: '/config.json',
      env: { CDP_TOOLS_IDLE_SUSPEND_MINUTES: '5' },
      readFile: () => JSON.stringify({ session: { idleSuspendMinutes: 30 } }),
    });
    expect(config.idleSuspendMinutes).toBe(5);
  });

  it('keeps 0 as an explicit "never suspend"', () => {
    const config = readSupervisorSessionConfig({
      configPath: '/config.json',
      env: {},
      readFile: () => JSON.stringify({ session: { idleSuspendMinutes: 0 } }),
    });
    expect(config.idleSuspendMinutes).toBe(0);
  });

  it('ignores a zero or negative poll interval rather than spinning', () => {
    const config = readSupervisorSessionConfig({
      configPath: '/config.json',
      env: {},
      readFile: () => JSON.stringify({ session: { clientPollSeconds: 0 } }),
    });
    expect(config.clientPollSeconds).toBe(DEFAULT_CLIENT_POLL_SECONDS);
  });

  it('falls back to defaults on a corrupt config file', () => {
    const config = readSupervisorSessionConfig({
      configPath: '/config.json',
      env: {},
      readFile: () => '{ not json',
    });
    expect(config.idleSuspendMinutes).toBe(DEFAULT_IDLE_SUSPEND_MINUTES);
  });

  it('ignores non-numeric values', () => {
    const config = readSupervisorSessionConfig({
      configPath: '/config.json',
      env: { CDP_TOOLS_IDLE_SUSPEND_MINUTES: 'soon' },
      readFile: () => JSON.stringify({ session: { idleSuspendMinutes: 'later' } }),
    });
    expect(config.idleSuspendMinutes).toBe(DEFAULT_IDLE_SUSPEND_MINUTES);
  });
});

describe('readSupervisorSessionConfig - global config', () => {
  it('follows configLocation global when the local file is only a stub', () => {
    // `config({ action: 'useGlobal' })` leaves exactly this stub behind, and
    // getConfigPath() returns it because it exists.
    const files: Record<string, string> = {
      '/local.json': JSON.stringify({ configLocation: 'global' }),
      '/global.json': JSON.stringify({ session: { idleSuspendMinutes: 0 } }),
    };
    const config = readSupervisorSessionConfig({
      configPath: '/local.json',
      globalConfigPath: '/global.json',
      env: {},
      readFile: (path) => files[path] ?? (() => { throw new Error('ENOENT'); })(),
    });
    expect(config.idleSuspendMinutes).toBe(0);
  });

  it('prefers a local session section over the global file', () => {
    const files: Record<string, string> = {
      '/local.json': JSON.stringify({ configLocation: 'global', session: { idleSuspendMinutes: 45 } }),
      '/global.json': JSON.stringify({ session: { idleSuspendMinutes: 5 } }),
    };
    const config = readSupervisorSessionConfig({
      configPath: '/local.json',
      globalConfigPath: '/global.json',
      env: {},
      readFile: (path) => files[path],
    });
    expect(config.idleSuspendMinutes).toBe(45);
  });

  it('treats an empty env var as unset rather than as "never suspend"', () => {
    const config = readSupervisorSessionConfig({
      configPath: '/nope.json',
      env: { CDP_TOOLS_IDLE_SUSPEND_MINUTES: '' },
      readFile: () => { throw new Error('ENOENT'); },
    });
    expect(config.idleSuspendMinutes).toBe(DEFAULT_IDLE_SUSPEND_MINUTES);
  });
});

describe('idleCheckIntervalMs', () => {
  it('checks every 5 minutes at the shipped default', () => {
    expect(idleCheckIntervalMs(DEFAULT_IDLE_SUSPEND_MINUTES * 60_000)).toBe(300_000);
  });

  it('suspends within a quarter of the threshold for shorter settings', () => {
    expect(idleCheckIntervalMs(20 * 60_000)).toBe(5 * 60_000); // 20min -> capped at 5min
    expect(idleCheckIntervalMs(8 * 60_000)).toBe(2 * 60_000);  // 8min -> quarter
    expect(idleCheckIntervalMs(60_000)).toBe(15_000);          // 1min -> quarter
  });

  it('never spins on a sub-minute threshold', () => {
    expect(idleCheckIntervalMs(1_800)).toBe(1_000);
    expect(idleCheckIntervalMs(0)).toBe(1_000);
  });
});
