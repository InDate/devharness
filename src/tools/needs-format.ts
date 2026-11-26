/**
 * Needs as the matrix and issues tools render them, and the refusals for a
 * write that `src/waits-on.ts` checks.
 */

import { createErrorResponse, type MCPResponse } from '../messages.js';
import type { ChainEnd, NeedProblem, NeedRefusal, NeedState, WaitingCell } from '../waits-on.js';

const PROBLEM_WORDS: Record<NeedProblem, string> = {
  'malformed': 'it matches no need form',
  'relative': 'a short form, which resolves on a matrix cell only',
  'issue-missing': 'no issue carries that number',
  'matrix-missing': 'the store holds no matrix of that name yet',
  'matrix-broken': 'its matrix file does not read',
  'scenario-missing': 'its matrix holds no such scenario',
  'capability-missing': 'its matrix holds no such capability',
  'na-target': 'that cell reads n/a, so this need never meets',
};

export const problemWords = (problem: NeedProblem): string => PROBLEM_WORDS[problem];

const OPEN_SHOWN = 6;

function openWords(open: string[]): string {
  return open.slice(0, OPEN_SHOWN).join(', ') + (open.length > OPEN_SHOWN ? ` and ${open.length - OPEN_SHOWN} more` : '');
}

/** One need as a Markdown list item: met, waiting on the cells still open, or its problem. */
export function needLine(state: NeedState): string {
  const shown = state.target && state.target !== state.ref ? `\`${state.ref}\` (${state.target})` : `\`${state.ref}\``;
  const standing = state.met ? 'met'
    : state.problem ? `unmet, ${problemWords(state.problem)}`
    : state.open ? `unmet, waiting on ${openWords(state.open)}`
    : 'unmet, the issue is open';
  const source = state.via ? ` _(from ${state.via})_` : state.from && state.from !== 'scenario' ? ` _(${state.from})_` : '';
  return `- ${shown}: ${standing}${source}`;
}

export function needBlock(states: NeedState[], heading: string): string {
  return states.length > 0 ? `\n${heading}:\n${states.map(needLine).join('\n')}` : '';
}

function endLine(end: ChainEnd): string {
  if (end.kind === 'problem') return `- ${end.ref}: ${problemWords(end.problem!)}`;
  if (end.kind === 'issue') return `- issue ${end.ref}, ${end.status}, waits on nothing open`;
  return `- ${end.ref}, ${end.today}, its needs met`;
}

/** The cell `next` skipped, what it waits on, and where those chains end. */
export function waitingBlock(waiting: WaitingCell): string {
  return `${waiting.ref} waits on:\n${waiting.unmet.map(needLine).join('\n')}`
    + (waiting.ends.length > 0 ? `\nThose chains end at:\n${waiting.ends.map(endLine).join('\n')}` : '');
}

export function needRefusalResponse(refusal: NeedRefusal): MCPResponse {
  if (refusal.kind === 'cycle') return createErrorResponse('NEEDS_CYCLE', { path: refusal.path.join(' → ') });
  return createErrorResponse('NEEDS_REFUSED', {
    ref: refusal.ref,
    at: refusal.at,
    problem: problemWords(refusal.problem),
    valid: refusal.valid.slice(0, 12).map(id => `\`${id}\``).join(', '),
  });
}
