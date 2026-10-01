/**
 * `runAll`: every sequence in a folder of the sequences dir, or every one
 * carrying a tag, run in filename order with one pass/fail line each.
 */
import { selectSuiteFiles, sequenceFolders } from '../helpers/sequence-tree.js';
import type { CommandRecorder } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import { createErrorResponse } from '../messages.js';
import { beginSuite } from '../run-log.js';
import { handleRun } from './replay-run.js';
import { collectVariableKeys } from './replay-run-inputs.js';
import { type ReplayArgs } from './replay-schema.js';
import { normalizeTags } from './replay-validation.js';

/**
 * Run every sequence in a folder, in filename order, and report one line each.
 *
 * Two behaviours make this usable as a suite runner rather than a loop:
 *  - the ENTIRE tree is loaded before anything runs, so a sequence in spine/
 *    can still reference a helper in _helpers/ by name (a check's `{ run }`,
 *    forEach `do`) — those resolve by sequence NAME, not by path;
 *  - a failure is recorded and the run continues (continueOnFailure, default
 *    true). A suite that stops at the first red reports far less than one
 *    that finishes and shows all of them.
 *
 * Folders whose name starts with '_' are loaded but never run on their own —
 * that is where preamble/helper sequences live, which are meaningless in
 * isolation and would fail if executed standalone.
 */
export async function handleRunAll(
  args: ReplayArgs,
  recorder: CommandRecorder,
  executeToolCall: ExecuteToolCall,
  getPageForConnection: (connection: string) => Promise<any>,
  abortSignal?: AbortSignal,
  getConnectionPort?: (connection: string) => Promise<number | null>
) {
  // Stay inside ONE root. listSavedSequencesOnDisk merges the project dir with
  // ~/.devharness/sequences, and a bare runAll that swept in the user's global
  // sequences would execute unrelated suites from other projects — and a name
  // colliding across the two roots would select twice.
  const wantLocation = args.global ? 'global' : 'working-dir';
  const onDisk = (await recorder.listSavedSequencesOnDisk())
    .filter(e => e.location === wantLocation);
  if (onDisk.length === 0) {
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'folder',
      value: String(args.folder ?? ''),
      message: `No sequences found in the ${args.global ? 'global (~/.devharness/sequences)' : 'project'} sequences directory. Export or record one first${args.global ? '' : ', or pass global:true to run the global ones'}.`
    });
  }

  // Load everything first so cross-folder name references resolve.
  for (const entry of onDisk) {
    await recorder.loadSequenceFromDisk(entry.fullPath);
  }

  const folder = (args.folder || '').replace(/^\/+|\/+$/g, '');
  const chosen = new Set(selectSuiteFiles(onDisk.map(e => e.filename), folder));
  const tagsOf = (name: string) => recorder.listSequences().find(s => s.name === name)?.tags ?? [];

  // Tag selection runs after the folder pick, so `folder` and `tags` compose:
  // "the ui sequences in spine/" is one call, not a choice between two axes.
  let wantTags: string[] = [];
  if (args.tags !== undefined) {
    const cleaned = normalizeTags(args.tags);
    if ('error' in cleaned) {
      return createErrorResponse('INVALID_PARAMETER', { parameter: 'tags', value: args.tags.join(', '), message: cleaned.error });
    }
    wantTags = cleaned.tags;
  }

  const inFolder = onDisk
    .filter(e => chosen.has(e.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const selected = wantTags.length === 0
    ? inFolder
    : inFolder.filter(e => tagsOf(e.name).some(t => wantTags.includes(t)));

  if (wantTags.length > 0 && selected.length === 0) {
    const available = [...new Set(inFolder.flatMap(e => tagsOf(e.name)))].sort();
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'tags',
      value: wantTags.join(', '),
      message: `No sequence ${folder ? `under "${folder}" ` : ''}carries ${wantTags.length > 1 ? 'any of those tags' : `the tag "${wantTags[0]}"`}. ` +
        (available.length
          ? `Tags in use here: ${available.join(', ')}.`
          : `No sequence here is tagged yet - set one with replay({ action: 'declare', name: '...', tags: ['ui'] }).`),
    });
  }

  if (selected.length === 0) {
    const folders = sequenceFolders(onDisk.map(e => e.filename));
    return createErrorResponse('INVALID_PARAMETER', {
      parameter: 'folder',
      value: folder,
      message: `No sequences under "${folder}". ` +
        (folders.length ? `Available folders: ${folders.join(', ')}.` : 'No subfolders exist yet — sequences are all at the top level.')
    });
  }

  // One `variables` map covers the whole suite, so a key is a typo only when it
  // matches NO member. Checked once, before anything runs: a supplied key that
  // lands nowhere is dropped in silence by the executor and every sequence runs
  // on its recorded text, which for a credential means the recorded one reaching
  // the live app with the suite reporting green. The whole tree is in memory by
  // now, so the union is exhaustive.
  if (args.variables && Object.keys(args.variables).length > 0) {
    const suiteKeys = new Set<string>();
    for (const entry of selected) {
      const seq = recorder.listSequences().find(sq => sq.name === entry.name);
      if (!seq) continue;
      for (const key of collectVariableKeys(seq.commands, recorder).keys) suiteKeys.add(key);
    }
    const unmatched = Object.keys(args.variables).filter(k => !suiteKeys.has(k));
    if (unmatched.length > 0) {
      const known = [...suiteKeys].sort();
      return createErrorResponse('INVALID_PARAMETER', {
        parameter: 'variables',
        value: unmatched.join(', '),
        message: `${unmatched.length > 1 ? 'Those keys name' : `"${unmatched[0]}" names`} no typed-text step in any sequence this run selects. ` +
          `The key is BUILT from the selector - var_<0-based step index>_<selector, non-alphanumerics replaced by _> - so "#password" at step 3 is "var_3__password", with two underscores. ` +
          (known.length
            ? `Substitutable across this suite: ${known.join(', ')}.`
            : `No sequence here has typed text to substitute.`),
      });
    }
  }

  const keepGoing = args.continueOnFailure !== false;
  const results: Array<{ filename: string; name: string; ok: boolean; detail: string }> = [];
  const suite = beginSuite(
    [folder ? `folder ${folder}` : 'all sequences', wantTags.length ? `tagged ${wantTags.join(' or ')}` : ''].filter(Boolean).join(', '),
    selected.map(entry => entry.name),
  );

  for (const [index, entry] of selected.entries()) {
    // killChromeOnFinish means the SUITE's finish here, not each sequence's: a
    // teardown between sequences destroys the state a _helpers preamble just
    // established. Only the last sequence carries it, so a suite that stops
    // early (continueOnFailure: false, a cancel) leaves the browsers up for
    // the failure to be read in.
    const isLast = index === selected.length - 1;
    if (abortSignal?.aborted) {
      results.push({ filename: entry.filename, name: entry.name, ok: false, detail: 'cancelled before it ran' });
      continue;
    }
    let ok = false;
    let detail = '';
    try {
      // Reuse handleRun so a suite run and a single run cannot drift apart.
      const res: any = await handleRun(
        {
          ...args,
          action: 'run',
          folder: undefined,
          continueOnFailure: undefined,
          name: undefined,
          sequenceId: entry.id,
          wait: true,
          // A suite has nobody to answer a prompt. Keeping the recorded values
          // is the only unattended behaviour that still runs the sequence;
          // leaving it undefined turns every parameterised sequence into a
          // no-op that a caller then has to notice.
          variables: args.variables ?? {},
          // Per-run args that are actively wrong when fanned across a suite:
          // startFrom/stepTo/stepCount/startUrl mean something only for one
          // specific sequence. baseUrl does carry - it retargets every
          // sequence at the same deployment, which is what a suite run of a
          // recorded set against another environment needs.
          killChromeOnFinish: isLast ? args.killChromeOnFinish : undefined,
          startFrom: undefined,
          stepTo: undefined,
          stepCount: undefined,
          startUrl: undefined,
        },
        recorder, executeToolCall, getPageForConnection, abortSignal, getConnectionPort,
        { validateVariableKeys: false, suite: { id: suite.id, label: suite.label } }
      );
      const text = (res?.content || []).map((c: any) => c?.text || '').join('\n');
      // performRun stamps _meta.replay on every terminal response, and the
      // outcome is read from it rather than the prose: a line starting with
      // "Error:" misses non-run outcomes (a variables prompt, a pause) and
      // matches any step output that happens to echo one.
      const meta = res?._meta?.replay;
      if (meta && typeof meta.success === 'boolean') {
        ok = meta.success === true && meta.paused !== true && meta.prompted !== true;
        detail = meta.prompted
          ? 'did not run: it has recorded variables and none were supplied — pass variables:{} to keep the recorded values'
          : meta.cancelled
            ? 'cancelled while it ran'
          : meta.paused
            ? 'did not finish: the run PAUSED (stepTo, a breakpoint, or click validation) and is still open'
            : (text.match(/\*\*Socket health failed\*\*[\s\S]*?(?=\n\n\*\*|$)/)?.[0]?.replace(/\s+/g, ' ').slice(0, 200)
             || text.match(/\*\*Strict run failed\*\*[\s\S]*/)?.[0]?.replace(/\s+/g, ' ').slice(0, 200)
             || text.match(/^\s*Error:.*$/m)?.[0]
             || `failed at ${meta.failedSteps ?? '?'} step(s)`).trim();
      } else {
        // No _meta means this was not a terminal run response at all.
        ok = false;
        detail = (text.match(/^\s*Error:.*$/m)?.[0] || text.split('\n')[0] || 'no run result').trim();
      }
    } catch (err: any) {
      ok = false;
      detail = `threw: ${err?.message || String(err)}`;
    }
    results.push({ filename: entry.filename, name: entry.name, ok, detail });
    suite.done += 1;
    if (!ok) suite.failed += 1;
    if (!ok && !keepGoing) break;
  }
  suite.endedAt = Date.now();

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  const scope = [
    folder ? `folder "${folder}"` : 'all sequences',
    wantTags.length ? `tagged ${wantTags.join(' or ')}` : '',
  ].filter(Boolean).join(', ');

  // What the suite actually covered, reported every run rather than needing an
  // audit to discover: "36 passed" reads as interface coverage whether or not
  // any of it drove the interface.
  const tagCounts = new Map<string, number>();
  let untagged = 0;
  for (const r of results) {
    const tags = tagsOf(r.name);
    if (tags.length === 0) untagged++;
    for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }
  const split = [
    ...[...tagCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, n]) => `${n} ${tag}`),
    ...(untagged > 0 ? [`${untagged} untagged`] : []),
  ].join(', ');
  const lines = results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.filename}${r.ok ? '' : `  — ${r.detail}`}`);
  const skipped = selected.length - results.length;

  return {
    content: [{
      type: 'text',
      text: [
        `runAll ${scope}: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} not run (stopped at first failure)` : ''}` +
          (split ? ` (${split})` : ''),
        '',
        ...lines,
        '',
        `Loaded ${onDisk.length} sequence(s) from disk; ran ${results.length}.`,
      ].join('\n')
    }],
    ...(failed > 0 ? { isError: true } : {})
  };
}
