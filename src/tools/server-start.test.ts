import { describe, it, expect, vi } from 'vitest';
import { createServerTools } from './server-tools.js';

const SAVED = {
  type: 'native', id: 'socket-app', command: 'node examples/socket-app/server.mjs',
  cwd: '/work/devharness', pid: -1, port: 7788, autoRun: false, startedAt: '',
  monitorPort: true, watch: false, watchPaths: ['/work/devharness'],
};

function makeServer() {
  const serverManager = {
    savedServer: vi.fn(async (id: string) => (id === 'socket-app' ? SAVED : null)),
    startServer: vi.fn(async (options: any) => ({ id: options.id, pid: 42, runnerType: 'native' })),
    getStatus: vi.fn(async () => [{ port: 7788, autoRun: false }]),
    getLogStats: () => [],
  };
  return { serverManager, server: createServerTools(serverManager as any).server };
}

describe('server start of a server saved under its name', () => {
  it('starts it from its saved command, directory and settings', async () => {
    const { serverManager, server } = makeServer();

    const result: any = await server.handler({ action: 'start', id: 'socket-app' });

    expect(result.isError).toBeFalsy();
    expect(serverManager.startServer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'socket-app', command: SAVED.command, cwd: SAVED.cwd, port: 7788,
      runner: 'native', monitorPort: true, watch: false,
    }));
  });

  it('takes the name as serverId too, as the other actions do', async () => {
    const { serverManager, server } = makeServer();

    await server.handler({ action: 'start', serverId: 'socket-app' });

    expect(serverManager.startServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'socket-app', command: SAVED.command }));
  });

  it('lets a parameter the call gives override the saved one', async () => {
    const { serverManager, server } = makeServer();

    await server.handler({ action: 'start', id: 'socket-app', command: 'node other.mjs' });

    expect(serverManager.startServer).toHaveBeenCalledWith(expect.objectContaining({ command: 'node other.mjs', cwd: SAVED.cwd }));
  });

  it('passes clearLogs through to the start', async () => {
    const { serverManager, server } = makeServer();

    await server.handler({ action: 'start', id: 'socket-app', clearLogs: true });

    expect(serverManager.startServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'socket-app', clearLogs: true }));
  });

  it('still asks for a command for a name nothing is saved under', async () => {
    const { serverManager, server } = makeServer();

    const result: any = await server.handler({ action: 'start', id: 'new-app' });

    expect(result.isError).toBe(true);
    expect(serverManager.startServer).not.toHaveBeenCalled();
  });
});
