/**
 * Startup Time Measurement Script
 *
 * Measures the import time of all dependencies to identify startup bottlenecks.
 * Run with: node scripts/measure-startup.mjs
 *
 * Can be used as a build verification step to ensure startup time doesn't regress.
 */

const start = performance.now();

// Configuration
const WARN_THRESHOLD_MS = 800;  // Warn if total startup exceeds this
const FAIL_THRESHOLD_MS = 2000; // Fail if total startup exceeds this
const isCI = process.env.CI === 'true';
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');

function log(msg) {
  const elapsed = (performance.now() - start).toFixed(0);
  console.error(`${elapsed}ms: ${msg}`);
}

function logVerbose(msg) {
  if (verbose) {
    log(msg);
  }
}

log('Measuring startup time...');

// Track individual import times
const importTimes = [];

async function measureImport(name, importFn) {
  const importStart = performance.now();
  await importFn();
  const importTime = performance.now() - importStart;
  importTimes.push({ name, time: importTime });
  logVerbose(`Imported ${name} (${importTime.toFixed(0)}ms)`);
}

// External dependencies
await measureImport('@modelcontextprotocol/sdk', () => import('@modelcontextprotocol/sdk/server/index.js'));
await measureImport('stdio-transport', () => import('@modelcontextprotocol/sdk/server/stdio.js'));
await measureImport('mcp-types', () => import('@modelcontextprotocol/sdk/types.js'));
await measureImport('zod', () => import('zod'));
await measureImport('puppeteer-core', () => import('puppeteer-core'));
await measureImport('source-map', () => import('source-map'));

// Project modules
await measureImport('cdp-manager', () => import('../build/cdp-manager.js'));
await measureImport('sourcemap-handler', () => import('../build/sourcemap-handler.js'));
await measureImport('chrome-launcher', () => import('../build/chrome-launcher.js'));
await measureImport('puppeteer-manager', () => import('../build/puppeteer-manager.js'));
await measureImport('console-monitor', () => import('../build/console-monitor.js'));
await measureImport('network-monitor', () => import('../build/network-monitor.js'));
await measureImport('connection-manager', () => import('../build/connection-manager.js'));
await measureImport('logpoint-execution-tracker', () => import('../build/logpoint-execution-tracker.js'));
await measureImport('port-reserver', () => import('../build/port-reserver.js'));
await measureImport('validation-helpers', () => import('../build/validation-helpers.js'));
await measureImport('clickable-cache', () => import('../build/clickable-cache.js'));
await measureImport('command-recorder', () => import('../build/command-recorder.js'));

// Tool files
await measureImport('breakpoint-tools', () => import('../build/tools/breakpoint-tools.js'));
await measureImport('execution-tools', () => import('../build/tools/execution-tools.js'));
await measureImport('inspection-tools', () => import('../build/tools/inspection-tools.js'));
await measureImport('source-tools', () => import('../build/tools/source-tools.js'));
await measureImport('console-tools', () => import('../build/tools/console-tools.js'));
await measureImport('network-tools', () => import('../build/tools/network-tools.js'));
await measureImport('page-tools', () => import('../build/tools/page-tools.js'));
await measureImport('dom-tools', () => import('../build/tools/dom-tools.js'));
await measureImport('screenshot-tools', () => import('../build/tools/screenshot-tools.js'));
await measureImport('input-tools', () => import('../build/tools/input-tools.js'));
await measureImport('content-tools', () => import('../build/tools/content-tools.js'));
await measureImport('storage-tools', () => import('../build/tools/storage-tools.js'));
await measureImport('connection-tools', () => import('../build/tools/connection-tools.js'));
await measureImport('download-tools', () => import('../build/tools/download-tools.js'));
await measureImport('modal-tools', () => import('../build/tools/modal-tools.js'));
await measureImport('replay-tools', () => import('../build/tools/replay-tools.js'));
await measureImport('messages', () => import('../build/messages.js'));
await measureImport('debug-logger', () => import('../build/debug-logger.js'));
await measureImport('reference-validator', () => import('../build/reference-validator.js'));

const totalTime = performance.now() - start;

// Report results
console.error('');
console.error('=== Startup Time Report ===');
console.error(`Total import time: ${totalTime.toFixed(0)}ms`);

// Find slowest imports
const sortedImports = [...importTimes].sort((a, b) => b.time - a.time);
const slowestImports = sortedImports.slice(0, 5);

console.error('');
console.error('Slowest imports:');
for (const { name, time } of slowestImports) {
  console.error(`  ${name}: ${time.toFixed(0)}ms`);
}

// Categorize by external vs internal
const externalImports = importTimes.filter(i =>
  !i.name.includes('-tools') &&
  !i.name.includes('-monitor') &&
  !i.name.includes('-manager') &&
  !i.name.includes('-handler') &&
  !i.name.includes('-launcher') &&
  !i.name.includes('-reserver') &&
  !i.name.includes('-tracker') &&
  !i.name.includes('-cache') &&
  !i.name.includes('-recorder') &&
  !i.name.includes('-validator') &&
  !i.name.includes('-logger') &&
  !i.name.includes('messages')
);
const internalImports = importTimes.filter(i => !externalImports.includes(i));

const externalTime = externalImports.reduce((sum, i) => sum + i.time, 0);
const internalTime = internalImports.reduce((sum, i) => sum + i.time, 0);

console.error('');
console.error('Breakdown:');
console.error(`  External dependencies: ${externalTime.toFixed(0)}ms`);
console.error(`  Internal modules: ${internalTime.toFixed(0)}ms`);

// Check thresholds
let exitCode = 0;

if (totalTime > FAIL_THRESHOLD_MS) {
  console.error('');
  console.error(`ERROR: Startup time (${totalTime.toFixed(0)}ms) exceeds fail threshold (${FAIL_THRESHOLD_MS}ms)`);
  exitCode = 1;
} else if (totalTime > WARN_THRESHOLD_MS) {
  console.error('');
  console.error(`WARNING: Startup time (${totalTime.toFixed(0)}ms) exceeds warn threshold (${WARN_THRESHOLD_MS}ms)`);
  // Don't fail on warning, just notify
}

console.error('');

// Output summary for programmatic use
console.log(JSON.stringify({
  totalMs: Math.round(totalTime),
  externalMs: Math.round(externalTime),
  internalMs: Math.round(internalTime),
  slowest: slowestImports.map(i => ({ name: i.name, ms: Math.round(i.time) })),
  pass: exitCode === 0,
  warnThresholdMs: WARN_THRESHOLD_MS,
  failThresholdMs: FAIL_THRESHOLD_MS,
}));

process.exit(exitCode);
