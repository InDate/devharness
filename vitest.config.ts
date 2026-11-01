import { defineConfig } from 'vitest/config';

// These files read state another file leaves behind (fakes, module-level
// registries, mocks, the working directory) and fail in a shared module graph,
// so each runs in a process of its own. The rest share one graph per worker,
// which drops the per-file process start and import.
const needsIsolation = [
      'src/bench-mode.test.ts',
      'src/bench-mode/motion-film.test.ts',
      'src/bench-mode/secrets.test.ts',
      'src/cdp-manager-own-script-pause.test.ts',
      'src/connection-hints.test.ts',
      'src/github/gh-cli.test.ts',
      'src/messages-once.test.ts',
      'src/proxy/provenance.test.ts',
      'src/root-credit.test.ts',
      'src/tools/check-engine-socket.test.ts',
      'src/tools/connection-routing.test.ts',
      'src/tools/execution-logpoint-limit.test.ts',
      'src/tools/modal-tools.test.ts',
      'src/tools/replay-env-default.test.ts',
      'src/tools/replay-env-file.test.ts',
      'src/tools/replay-output-and-record-options.test.ts',
      'src/tools/replay-pause-note.test.ts',
      'src/tools/replay-person-hold.test.ts',
      'src/tools/run-table.test.ts',
];

export default defineConfig({
  test: {
    globals: true,
    restoreMocks: true,
    environment: 'node',
    // A windowed launch waits for the Terminal's macOS desktop before Chrome
    // starts; under test that wait reads the real desktop, so a run made while
    // the person is on another desktop holds until the test times out.
    env: { CDP_TOOLS_DESKTOP_WAIT: '0' },
    projects: [
      { extends: true, test: { name: 'shared', isolate: false, include: ['src/**/*.test.ts'], exclude: needsIsolation } },
      { extends: true, test: { name: 'isolated', include: needsIsolation } },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'build/**',
      ],
    },
  },
});
