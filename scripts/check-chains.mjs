#!/usr/bin/env node

/**
 * Holds a baseline of chains-every-key to the chains examples/motion/chains.html
 * declares for each of its scenarios.
 *
 * A motion row carries `chain`, the marks from its cause back to its root;
 * `cuts.motion`, the motion it cut short; and on a stopped row `ends`, the
 * motion it ended. A wrong link in any of them misnames what started a motion
 * while every trigger string reads correctly, so each scenario's rows are
 * read against the page's #expect block: the kinds of the links in order, the
 * words of the root, which earlier motion a cut or an end names, and whether a
 * fork's motions share one root mark.
 *
 * Reads .devharness/sequences/<name>.json and .devharness/activity/<name>.json,
 * so it judges the newest baseline taken. A scenario marked `gap` names a cause
 * the tracker does not carry yet: its failure is listed and leaves the exit code 0.
 *
 *   node scripts/check-chains.mjs [sequence-name]
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] ?? 'chains-every-key';
const read = file => JSON.parse(readFileSync(path.join(repo, file), 'utf-8'));

const page = readFileSync(path.join(repo, 'examples/motion/chains.html'), 'utf-8');
const { scenarios } = JSON.parse(page.match(/<script type="application\/json" id="expect">([\s\S]*?)<\/script>/)[1]);
const sequence = read(`.devharness/sequences/${name}.json`);
const activity = read(`.devharness/activity/${name}.json`);

const motionsOf = step => (activity.steps?.[String(step)]?.traffic?.observations ?? []).filter(one => one.kind === 'motion');
const stamps = Object.values(activity.steps ?? {}).map(step => step.traffic?.capturedBy).filter(Boolean);
const tokens = row => row.key.split(' ');
const isStart = row => !row.key.endsWith(' ended');
const matches = (row, want) => isStart(row) && tokens(row).includes(want.el) && (want.name === undefined || tokens(row)[0] === want.name);
const describeChain = row => (row.motion?.chain ?? []).map(link => link.kind + (link.words ? `[${link.words}]` : '')).join(' ← ') || '(no chain)';

/** The step of the sequence that drives a scenario: the command whose params match its drive. */
function stepOf(scenario) {
  const d = scenario.drive;
  return sequence.commands.findIndex(command => {
    const p = command.params ?? {};
    if (d.key) return p.action === 'press' && p.key === d.key;
    if (d.keys) return p.action === 'press' && JSON.stringify(p.keys) === JSON.stringify(d.keys);
    if (d.hover) return p.action === 'hover' && p.selector === d.hover;
    return p.action === 'click' && p.selector === d.click;
  });
}

const results = [];
for (const scenario of scenarios) {
  const step = stepOf(scenario);
  const problems = [];
  if (step < 0) problems.push('the sequence has no step driving it');
  // A motion no root places lands under whichever step ran when its report
  // arrived: a scenario with no root to carry, or one whose cause the tracker
  // drops, is looked for in its own step and the one after.
  const searched = scenario.motions.some(one => one.anyStep) ? Object.keys(activity.steps ?? {}).map(Number)
    : scenario.motions.some(one => one.gap) ? [step, step + 1] : [step];
  const rows = searched.flatMap(motionsOf);
  const taken = new Set();
  const resolved = [];
  for (const [index, want] of scenario.motions.entries()) {
    const candidates = rows.filter(row => matches(row, want) && !taken.has(row));
    const wanted = want.count === 'any' ? Math.max(1, candidates.length) : want.count ?? 1;
    const found = candidates.slice(0, wanted);
    found.forEach(row => taken.add(row));
    resolved[index] = found[0];
    if (found.length < wanted || (want.count === 'any' && candidates.length === 0)) {
      problems.push(`motion ${index} (${want.name ?? ''} ${want.el}): ${found.length} row(s), ${want.count ?? 1} expected`.replace('( ', '('));
    }
    for (const row of found) {
      const chain = row.motion?.chain ?? [];
      const label = `motion ${index} (${row.key})`;
      if (want.chain && JSON.stringify(chain.map(link => link.kind)) !== JSON.stringify(want.chain)) {
        problems.push(`${label}: chain ${describeChain(row)}, expected ${want.chain.join(' ← ')}`);
      }
      if (want.head && chain.at(-1)?.words !== want.head) {
        problems.push(`${label}: root ${chain.at(-1)?.words ?? '(none)'}, expected ${want.head}`);
      }
    }
  }
  for (const [index, want] of scenario.motions.entries()) {
    const row = resolved[index];
    if (!row) continue;
    const label = `motion ${index} (${row.key})`;
    if (want.cuts !== undefined) {
      const cut = resolved[want.cuts];
      if (row.motion?.cuts?.motion !== cut?.motion?.id) {
        problems.push(`${label}: cuts ${row.motion?.cuts?.motion ?? '(none)'}, expected motion ${want.cuts} (id ${cut?.motion?.id ?? '?'})`);
      }
      const ended = rows.find(one => one.key.endsWith(' ended') && one.motion?.ends === cut?.motion?.id);
      if (!ended) problems.push(`${label}: no ended row names motion ${want.cuts} (id ${cut?.motion?.id ?? '?'})`);
    }
    if (want.after !== undefined) {
      const before = resolved[want.after];
      const link = `motion:${before?.motion?.id}`;
      if (!(row.motion?.chain ?? []).some(one => one.id === link)) {
        problems.push(`${label}: chain names no ${link}, the end of motion ${want.after}`);
      }
    }
  }
  if (scenario.samePress) {
    const roots = new Set(resolved.filter(Boolean).map(row => row.motion?.chain?.at(-1)?.id));
    if (roots.size !== 1) problems.push(`the fork's motions end at ${roots.size} root marks, expected one`);
  }
  const gap = scenario.motions.find(one => one.gap)?.gap;
  results.push({ scenario, problems, gap });
}

console.log(`${name}: ${scenarios.length} scenarios, captured by ${JSON.stringify(stamps[0] ?? 'an unstamped build')}`);
for (const { scenario, problems, gap } of results) {
  const verdict = problems.length === 0 ? 'pass' : gap ? 'gap ' : 'FAIL';
  console.log(`${verdict}  ${scenario.id.padEnd(3)} ${scenario.title}${gap && problems.length ? `  (${gap})` : ''}`);
  for (const problem of problems) console.log(`        ${problem}`);
}
const failed = results.filter(one => one.problems.length && !one.gap).length;
const gaps = results.filter(one => one.problems.length && one.gap).length;
console.log(`\n${results.length - failed - gaps} pass, ${failed} fail, ${gaps} known gap${gaps === 1 ? '' : 's'}`);
process.exitCode = failed ? 1 : 0;
