/**
 * The socket-app's saved sequences, run against real Chrome on each layout
 * the app serves, each held to the outcome that layout is built to produce.
 *
 * The vitest suite never spawns Chrome, so its fakes cover nothing of what a
 * page does. These sequences are the record the tool is judged by: a step that
 * passes on layout 1 and a release (LAYOUT=2, LAYOUT=3) that moves, renames or
 * hides what it reaches. Each run goes through `devharness run` in a fresh
 * headless Chrome, from a copy of examples/socket-app in a temporary project,
 * so the working sequences under .devharness are never read or written.
 * Needs a build first.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const example = path.join(repo, 'examples/socket-app');
const entry = path.join(repo, 'build/index.js');

/**
 * What each layout is built to produce in each sequence. `pass` is a run that
 * completes; otherwise the run ends unsuccessful and its output holds `says`.
 */
const EXPECTED = {
  1: {
    'prefs-by-testid': { pass: true },
    'prefs-by-position': { pass: true },
    'prefs-by-text': { pass: true },
    'prefs-autoplay': { pass: true },
  },
  2: {
    'prefs-by-testid': { pass: true },
    'prefs-by-position': { pass: false, says: 'reaches another element' },
    'prefs-by-text': { pass: false, says: 'Element not found' },
    'prefs-autoplay': { pass: true },
  },
  3: {
    'prefs-by-testid': { pass: false, says: 'open-prefs' },
    'prefs-autoplay': { pass: false, says: 'open-prefs' },
  },
};

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer().listen(0, () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  }).on('error', reject);
});

/** The socket-app on `port`, serving `layout`, resolved once it listens. */
async function startApp(port, layout) {
  const app = spawn(process.execPath, [path.join(example, 'server.mjs')], {
    env: { ...process.env, PORT: String(port), LAYOUT: String(layout) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    app.stdout.on('data', chunk => { if (String(chunk).includes('socket-app on')) resolve(); });
    app.on('exit', code => reject(new Error(`socket-app exited with ${code} before listening`)));
  });
  return app;
}

/** One `devharness run`, from the temporary project, with its exit code and output. */
function runSequence(project, name, baseUrl) {
  return new Promise(resolve => {
    const run = spawn(process.execPath, [entry, 'run', name, `--base-url=${baseUrl}`], {
      cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    run.stdout.on('data', chunk => { output += chunk; });
    run.stderr.on('data', chunk => { output += chunk; });
    run.on('exit', code => resolve({ code, output }));
  });
}

const project = mkdtempSync(path.join(os.tmpdir(), 'devharness-check-sequences-'));
cpSync(path.join(example, 'sequences'), path.join(project, '.devharness/sequences'), { recursive: true });
cpSync(path.join(example, 'activity'), path.join(project, '.devharness/activity'), { recursive: true });

const results = [];
try {
  for (const [layout, sequences] of Object.entries(EXPECTED)) {
    const port = await freePort();
    const app = await startApp(port, layout);
    try {
      for (const [name, expected] of Object.entries(sequences)) {
        const { code, output } = await runSequence(project, name, `http://localhost:${port}`);
        const passed = code === 0;
        const held = expected.pass ? passed : !passed && output.includes(expected.says);
        results.push({ layout, name, held, expected, passed, output });
      }
    } finally {
      app.kill();
    }
  }
} finally {
  rmSync(project, { recursive: true, force: true });
}

for (const r of results) {
  const want = r.expected.pass ? 'passes' : `fails with "${r.expected.says}"`;
  console.log(`${r.held ? 'ok  ' : 'FAIL'} layout ${r.layout} ${r.name}: ${want}${r.held ? '' : ` - it ${r.passed ? 'passed' : 'failed otherwise'}`}`);
  if (!r.held) console.log(r.output.split('\n').slice(0, 20).map(line => `       ${line}`).join('\n'));
}
const failed = results.filter(r => !r.held).length;
console.log(`\n${results.length - failed}/${results.length} held`);
process.exit(failed === 0 ? 0 : 1);
