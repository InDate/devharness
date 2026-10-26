/**
 * Acknowledging a monitored port's failure, against real TCP ports.
 *
 * The block names a port that was down when it was read; by the time the
 * acknowledgment arrives the port may be up again. That port holds nothing, so
 * the acknowledgment answers it as up rather than as a mistake; only a port
 * that is not monitored at all is one.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'net';
import { PortMonitor } from './server-manager.js';

const monitors: PortMonitor[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  for (const m of monitors.splice(0)) await m.stopAll();
  for (const s of servers.splice(0)) await new Promise(resolve => s.close(resolve));
});

function monitor(): PortMonitor {
  const m = new PortMonitor(() => 50);
  monitors.push(m);
  return m;
}

async function listening(): Promise<number> {
  const server = net.createServer(socket => socket.on('error', () => {}));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const port = await listening();
  await new Promise(resolve => servers.pop()!.close(resolve));
  return port;
}

describe('acknowledging a monitored port', () => {
  it('acknowledges a port that is down, and its block lifts', async () => {
    const m = monitor();
    const port = await closedPort();
    await m.startMonitoring(port, 'block');
    await vi.waitFor(() => expect(m.getFailedPorts().map(p => p.port)).toContain(port), { timeout: 8000 });

    expect(await m.acknowledgeFailure(port)).toBe('acknowledged');
    expect(m.getFailedPorts()).toEqual([]);
  }, 10000);

  it('answers a port that is up again as up', async () => {
    const m = monitor();
    const port = await listening();
    await m.startMonitoring(port, 'block');
    // The monitor's probe has reached the listening port by now.
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(await m.acknowledgeFailure(port)).toBe('up');
  }, 10000);

  it('answers a port nothing monitors as unmonitored', async () => {
    expect(await monitor().acknowledgeFailure(65000)).toBe('unmonitored');
  });
});
