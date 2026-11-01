import { describe, it, expect } from 'vitest';
import {
  classifySync, resolveStatus, unionLabels, bodyHash, closedReasonFrom,
  markComment, commentGithubId, stripCommentMarker,
} from './gh-issues.js';

const SYNCED_AT = new Date('2026-08-01T00:00:00.000Z');
const NOW = new Date('2026-08-11T00:00:00.000Z');

function local(body: string, overrides: any = {}) {
  return { body, githubBodyHash: bodyHash(body), githubSyncedAt: SYNCED_AT, ...overrides };
}

describe('classifySync', () => {
  it('does nothing when neither side moved', () => {
    const issue = local('same');
    const result = classifySync(issue, { updatedAt: '2026-07-01T00:00:00.000Z' }, 'same');
    expect(result.action).toBe('none');
  });

  it('pulls when only the remote moved', () => {
    const issue = local('same');
    const result = classifySync(issue, { updatedAt: '2026-08-05T00:00:00.000Z' }, 'same');
    expect(result).toMatchObject({ action: 'pull', remoteChanged: true, localChanged: false });
  });

  it('pushes when only the local moved', () => {
    const issue = local('original');
    const result = classifySync(issue, { updatedAt: '2026-07-01T00:00:00.000Z' }, 'edited locally');
    expect(result).toMatchObject({ action: 'push', localChanged: true, remoteChanged: false });
  });

  it('reports a conflict when both moved', () => {
    const issue = local('original');
    const result = classifySync(issue, { updatedAt: '2026-08-05T00:00:00.000Z' }, 'edited locally');
    expect(result).toMatchObject({ action: 'conflict', localChanged: true, remoteChanged: true });
  });

  it('adopts rather than conflicting on a first sync', () => {
    // No baseline: the twelve issues stamped by hand are all in this state,
    // and none of them should come back as a conflict.
    const issue = { body: 'anything', githubBodyHash: undefined, githubSyncedAt: undefined };
    const result = classifySync(issue, { updatedAt: '2026-08-05T00:00:00.000Z' }, 'anything');
    expect(result).toMatchObject({ action: 'pull', firstSync: true });
  });

  it('reports missing-upstream when the number is gone', () => {
    expect(classifySync(local('x'), undefined, 'x').action).toBe('missing-upstream');
  });
});

describe('resolveStatus', () => {
  const openLocal = { type: 'bug' as const, status: 'acknowledged' as const, closedReason: undefined, startedAt: undefined, resolvedAt: undefined };
  const closedLocal = { type: 'bug' as const, status: 'fixed' as const, closedReason: 'completed' as const, startedAt: undefined, resolvedAt: new Date() };

  it('closes locally when upstream is closed', () => {
    const result = resolveStatus(openLocal, { state: 'CLOSED', stateReason: 'COMPLETED' }, NOW);
    expect(result).toMatchObject({ status: 'fixed', closedReason: 'completed', resolvedAt: NOW });
  });

  it('maps a feature to implemented, not fixed', () => {
    const result = resolveStatus({ ...openLocal, type: 'feature' }, { state: 'CLOSED', stateReason: 'COMPLETED' }, NOW);
    expect(result.status).toBe('implemented');
  });

  it('copies not planned and duplicate through verbatim', () => {
    expect(resolveStatus(openLocal, { state: 'CLOSED', stateReason: 'NOT_PLANNED' }, NOW).closedReason).toBe('not_planned');
    expect(resolveStatus(openLocal, { state: 'CLOSED', stateReason: 'DUPLICATE' }, NOW).closedReason).toBe('duplicate');
  });

  it('leaves an open issue alone when upstream is open', () => {
    expect(resolveStatus(openLocal, { state: 'OPEN', stateReason: null }, NOW)).toEqual({});
  });

  it('asks to close upstream when closed here but open there and never synced closed', () => {
    const notYetPushed = { ...closedLocal, closedReason: undefined };
    expect(resolveStatus(notYetPushed, { state: 'OPEN', stateReason: null }, NOW))
      .toMatchObject({ closeUpstream: 'completed' });
  });

  it('follows a reopen from GitHub and clears the resolution', () => {
    const result = resolveStatus(closedLocal, { state: 'OPEN', stateReason: null }, NOW);
    expect(result).toMatchObject({ status: 'acknowledged', reopened: true });
    expect(result.closedReason).toBeUndefined();
    expect(result.resolvedAt).toBeUndefined();
    // Never the other way round: a reopen must not become a close upstream.
    expect(result.closeUpstream).toBeUndefined();
  });

  it('reopens to in_progress when work had already started', () => {
    const result = resolveStatus({ ...closedLocal, startedAt: new Date() }, { state: 'OPEN', stateReason: null }, NOW);
    expect(result.status).toBe('in_progress');
  });
});

describe('unionLabels', () => {
  it('adds upstream labels without removing local-only ones', () => {
    expect(unionLabels(['inspect', 'agents'], ['bug', 'help wanted']))
      .toEqual(['inspect', 'agents', 'bug', 'help wanted']);
  });

  it('does not duplicate labels present on both sides', () => {
    expect(unionLabels(['bug', 'ui'], ['bug'])).toEqual(['bug', 'ui']);
  });
});

describe('closedReasonFrom', () => {
  it('normalises GitHub casing and spacing', () => {
    expect(closedReasonFrom('NOT_PLANNED')).toBe('not_planned');
    expect(closedReasonFrom('not planned')).toBe('not_planned');
    expect(closedReasonFrom('DUPLICATE')).toBe('duplicate');
  });

  it('falls back to completed for anything else', () => {
    expect(closedReasonFrom(null)).toBe('completed');
    expect(closedReasonFrom('REOPENED')).toBe('completed');
  });
});

describe('comment markers', () => {
  it('round-trips an id through a comment body', () => {
    const marked = markComment('IC_123', 'Reproduced on Firefox too.');
    expect(commentGithubId(marked)).toBe('IC_123');
    expect(stripCommentMarker(marked)).toBe('Reproduced on Firefox too.');
  });

  it('reports no id for a locally-authored comment', () => {
    expect(commentGithubId('Just a local note.')).toBeNull();
  });

  it('survives a body that itself starts with an HTML comment', () => {
    const marked = markComment('IC_9', '<!-- not a marker -->\nText');
    expect(commentGithubId(marked)).toBe('IC_9');
    expect(stripCommentMarker(marked)).toBe('<!-- not a marker -->\nText');
  });
});
