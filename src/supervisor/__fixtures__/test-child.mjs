/**
 * Tiny fixture process for child-manager.test.ts. Not part of the build -
 * run directly by Node during tests.
 *
 * argv[2] === 'ignore-sigterm': ignores SIGTERM so kill() must escalate to SIGKILL.
 * argv[2] === 'crash': exits non-zero immediately.
 * argv[2] === 'ignore-suspend': ignores SIGUSR2 so suspend() must escalate to kill().
 * Otherwise: behaves normally (dies on SIGTERM, and on the SIGUSR2 suspend signal).
 * Writes `ready` to stdout once its signal handlers are in place.
 */
const mode = process.argv[2];

if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => {
    // Deliberately do nothing.
  });
}

if (mode === 'ignore-suspend') {
  process.on('SIGUSR2', () => {
    // Deliberately do nothing - stay alive through the suspend request.
  });
} else {
  process.on('SIGUSR2', () => process.exit(0));
}

if (mode === 'crash') {
  process.exit(1);
}

process.stdout.write('ready\n');

// Stay alive until killed.
setInterval(() => {}, 1000 * 60 * 60);
