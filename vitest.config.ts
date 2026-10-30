import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
    // A windowed launch waits for the Terminal's macOS desktop before Chrome
    // starts; under test that wait reads the real desktop, so a run made while
    // the person is on another desktop holds until the test times out.
    env: { CDP_TOOLS_DESKTOP_WAIT: '0' },
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
