/**
 * Unit tests for:
 * - detectAutoRestartCommand: identifying dev commands that self-restart on
 *   file changes (--watch, nodemon, etc.), so devharness can warn about
 *   pairing them with an attached breakpoint debugger.
 * - extractInspectorPort: parsing a command's --inspect/--inspect-brk port,
 *   used to correlate a managed server with the CDP connection actually
 *   attached to it (NOT the server's own detected app/service port - those
 *   are normally different numbers).
 * - PortMonitor pause/resume refcounting: multiple paused CDP connections
 *   sharing one PortMonitor must not let one connection's resume re-arm
 *   monitoring while another is still frozen.
 * - PortMonitor.startMonitoring() self-healing a dormant port monitor
 *   instead of leaving it stuck (e.g. after an imbalanced pause/resume).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import { PortMonitor, detectAutoRestartCommand, extractInspectorPort } from './server-manager.js';

describe('detectAutoRestartCommand', () => {
  const cases: Array<[string, boolean]> = [
    ['node --watch app.js', true],
    ['node --watch=./src app.js', true],
    ['nodemon app.js', true],
    ['npx tsx watch src/index.ts', true],
    ['ts-node-dev src/index.ts', true],
    ['node-dev src/index.ts', true],
    ['bun --hot server.ts', true],
    ['bun --watch server.ts', true],
    ['deno run --watch main.ts', true],
    ['node app.js', false],
    ['npm run build', false],
    ['node serve.mjs', false],
    ['node --inspect=9229 app.js', false],
  ];

  it.each(cases)('command %j -> matches auto-restart pattern: %s', (command, expectMatch) => {
    const result = detectAutoRestartCommand(command);
    expect(result !== null).toBe(expectMatch);
  });
});

describe('extractInspectorPort', () => {
  const cases: Array<[string, number | null]> = [
    ['node --inspect=9229 app.js', 9229],
    ['node --inspect-brk=9229 app.js', 9229],
    ['node --inspect app.js', 9229], // bare flag defaults to Node's standard port
    ['node --inspect-brk app.js', 9229],
    ['node --inspect=0.0.0.0:9230 app.js', 9230], // host:port form
    ['node --watch --inspect=9231 app.js', 9231],
    ['node app.js', null], // no inspector flag at all
    ['node --watch app.js', null],
  ];

  it.each(cases)('command %j -> inspector port %s', (command, expected) => {
    expect(extractInspectorPort(command)).toBe(expected);
  });

  it('is distinct from a server\'s own detected app/service port', () => {
    // The whole point of this helper: a command that happens to serve HTTP
    // on 9229 but has no --inspect flag must NOT be mistaken for an
    // inspector on 9229 - matching must be based on the flag, not any
    // arbitrary port number appearing in the command.
    expect(extractInspectorPort('node server.js --port=9229')).toBeNull();
  });
});

describe('PortMonitor pause/resume refcounting', () => {
  let connectSpy: any;

  beforeEach(() => {
    // Stub out real socket connection attempts - we only care how many times
    // PortMonitor tries to (re)connect, not whether it actually succeeds.
    connectSpy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
      return this;
    });
  });

  afterEach(() => {
    connectSpy.mockRestore();
  });

  it('only reconnects once every pauseMonitoring() has a matching resumeMonitoring()', async () => {
    const monitor = new PortMonitor();
    await monitor.startMonitoring(9301, 'inform');
    connectSpy.mockClear(); // ignore the initial connect from startMonitoring

    monitor.pauseMonitoring();
    monitor.pauseMonitoring(); // a second, independent connection also pauses

    monitor.resumeMonitoring(); // balances only one of the two pauses
    expect(connectSpy).not.toHaveBeenCalled();

    monitor.resumeMonitoring(); // balances the second pause
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('an unbalanced resumeMonitoring() with no prior pause is a no-op', async () => {
    const monitor = new PortMonitor();
    await monitor.startMonitoring(9302, 'inform');
    connectSpy.mockClear();

    monitor.resumeMonitoring();

    expect(connectSpy).not.toHaveBeenCalled();
  });
});

describe('PortMonitor.startMonitoring self-heal', () => {
  let connectSpy: any;

  beforeEach(() => {
    connectSpy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
      return this;
    });
  });

  afterEach(() => {
    connectSpy.mockRestore();
  });

  it('reconnects a dormant existing port monitor instead of leaving it stuck', async () => {
    const monitor = new PortMonitor();
    await monitor.startMonitoring(9304, 'inform');
    connectSpy.mockClear();

    // No 'connect' event ever fired (socket.connect is stubbed), so this port's
    // monitor has no active socket and no pending reconnect timer - exactly the
    // dormant state an imbalanced pause/resume would leave it in.
    await monitor.startMonitoring(9304, 'inform');

    expect(connectSpy).toHaveBeenCalledTimes(1);
  });
});
