/**
 * Regression tests for bug-005: a Chrome launch silently discarded an explicit
 * `port` when `forceNewInstance` was set, and skipped the reference-reuse
 * check so two Chrome instances could share one reference.
 *
 * The handler lived in src/index.ts, which calls main() on import and so can
 * never be imported by a unit test. These tests used to work around that by
 * grepping the handler SOURCE for fragments like `'if (explicitPort !== undefined)'`
 * - which asserted nothing about behaviour and would have passed under any
 * logic bug that kept the tokens. The decision is now a pure exported function
 * (resolveLaunchPort) that the handler delegates to, and these tests execute it.
 */

import { describe, it, expect } from 'vitest';
import { resolveLaunchPort, type LaunchPortRequest } from './chrome-launcher.js';
import { getErrorMessage, getMessageCode } from './messages.js';

/** resolveLaunchPort input with recording stubs; override per test. */
function makeRequest(overrides: Partial<LaunchPortRequest> = {}) {
  const calls = { occupancyChecks: [] as number[], freePortLookups: 0 };
  const req: LaunchPortRequest = {
    reservedPort: 9222,
    isPortOccupied: async (port) => {
      calls.occupancyChecks.push(port);
      return false;
    },
    findFreePort: async () => {
      calls.freePortLookups++;
      return 9333;
    },
    ...overrides,
  };
  return { req, calls };
}

describe('resolveLaunchPort (bug-005)', () => {
  it('uses this session\'s reserved port when no port was given', async () => {
    const { req, calls } = makeRequest();

    expect(await resolveLaunchPort(req)).toEqual({ decision: 'use', port: 9222 });
    expect(calls.freePortLookups).toBe(0);
    expect(calls.occupancyChecks).toEqual([]);
  });

  it('honours an explicit port without probing it when not forcing', async () => {
    const { req, calls } = makeRequest({ explicitPort: 9555 });

    expect(await resolveLaunchPort(req)).toEqual({ decision: 'use', port: 9555 });
    // Reusing whatever is on that port is the point when not forcing a new one
    expect(calls.occupancyChecks).toEqual([]);
  });

  it('picks a free port for forceNewInstance without an explicit port', async () => {
    const { req, calls } = makeRequest({ forceNewInstance: true });

    expect(await resolveLaunchPort(req)).toEqual({ decision: 'use', port: 9333 });
    expect(calls.freePortLookups).toBe(1);
  });

  it('honours a free explicit port under forceNewInstance instead of relocating', async () => {
    const { req, calls } = makeRequest({ explicitPort: 9555, forceNewInstance: true });

    expect(await resolveLaunchPort(req)).toEqual({ decision: 'use', port: 9555 });
    expect(calls.occupancyChecks).toEqual([9555]);
    // The bug: it fell back to auto-selection and launched somewhere else
    expect(calls.freePortLookups).toBe(0);
  });

  it('errors instead of relocating when the forced explicit port is taken', async () => {
    const { req, calls } = makeRequest({
      explicitPort: 9555,
      forceNewInstance: true,
      isPortOccupied: async () => true,
    });

    expect(await resolveLaunchPort(req)).toEqual({ decision: 'forced-port-in-use', port: 9555 });
    expect(calls.freePortLookups).toBe(0);
  });

  it('never silently substitutes another port for an explicit one', async () => {
    for (const forceNewInstance of [false, true]) {
      for (const occupied of [false, true]) {
        const { req } = makeRequest({
          explicitPort: 9555,
          forceNewInstance,
          isPortOccupied: async () => occupied,
        });

        const result = await resolveLaunchPort(req);
        expect(result.port).toBe(9555);
      }
    }
  });
});

describe('bug-005 error templates', () => {
  it('renders CHROME_FORCED_PORT_IN_USE with the requested port', () => {
    const message = getErrorMessage('CHROME_FORCED_PORT_IN_USE', { port: '9223' });

    expect(message).not.toContain('Message not found');
    expect(message).toContain('9223');
    expect(message).not.toContain('{{');
    expect(getMessageCode('CHROME_FORCED_PORT_IN_USE')).toBe('PORT_IN_USE');
  });

  it('renders CHROME_REFERENCE_ALREADY_BOUND with the reference name', () => {
    const message = getErrorMessage('CHROME_REFERENCE_ALREADY_BOUND', { reference: 'device a one' });

    expect(message).not.toContain('Message not found');
    expect(message).toContain('device a one');
    expect(message).not.toContain('{{');
    expect(getMessageCode('CHROME_REFERENCE_ALREADY_BOUND')).toBe('REFERENCE_IN_USE');
  });
});
