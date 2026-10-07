import type { ServerManager } from '../server-manager.js';

/**
 * The ServerManagers a test file creates, stopped and closed by `closeAll()`.
 *
 * A started server leaves a port-detection loop that saves servers.json up to
 * 30s later, at whichever working directory is current then. A test that
 * restores the repo's directory before that loop ends has it write into the
 * repo's own .devharness/servers.json, where a dead server's entry blocks every
 * devharness call until acknowledged. `closeAll()` runs first in `afterEach`,
 * so every write lands in the test's own directory.
 */
export function trackedManagers() {
  const managers: ServerManager[] = [];
  return {
    track<T extends ServerManager>(manager: T): T {
      managers.push(manager);
      return manager;
    },
    async closeAll(): Promise<void> {
      for (const manager of managers.splice(0)) {
        await manager.stopAll();
        await manager.close();
      }
    },
  };
}
