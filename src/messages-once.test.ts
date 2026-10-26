/**
 * Tests for the once-per-session part of a message template.
 *
 * A tool called repeatedly returns its template each time. Orientation is true
 * every time and new only the first, so repeating it spends context on text
 * already read - twenty starts of the bench cost ten thousand tokens of
 * the same three paragraphs.
 */

import { describe, it, expect } from 'vitest';
import { createSuccessResponse, getMessage, withOnce } from './messages.js';
import { formatPageContextForResponse } from './tools/page-tools.js';

const textOf = (response: any): string => response.content[0].text;

describe('a template with a once-per-session part', () => {
  it('carries the orientation the first time and drops it after', () => {
    const first = textOf(createSuccessResponse('BENCH_STARTED', {
      connection: 'app', benchUrl: 'http://127.0.0.1:1/t/', eventStreamPath: '/tmp/e.jsonl',
    }));
    const second = textOf(createSuccessResponse('BENCH_STARTED', {
      connection: 'app', benchUrl: 'http://127.0.0.1:1/t/', eventStreamPath: '/tmp/e.jsonl',
    }));

    expect(first).toContain('HOLD stops page time');
    expect(second).not.toContain('HOLD stops page time');
    expect(second.length).toBeLessThan(first.length / 2);
  });

  it('still says what changed on every call', () => {
    const later = textOf(createSuccessResponse('BENCH_STARTED', {
      connection: 'second-app', benchUrl: 'http://127.0.0.1:2/u/', eventStreamPath: '/tmp/e.jsonl',
    }));

    expect(later).toContain('second-app');
    expect(later).toContain('http://127.0.0.1:2/u/');
  });

  it('carries the watch call on every start that finds no watch, once part or not', () => {
    const call = 'Bash({ command: "devharness watch --session=e", run_in_background: true })';
    const unwatched = textOf(createSuccessResponse('BENCH_STARTED', {
      connection: 'app', benchUrl: 'http://127.0.0.1:3/v/', eventStreamPath: '/tmp/e.jsonl', watchCall: call,
    }));
    const watched = textOf(createSuccessResponse('BENCH_STARTED', {
      connection: 'app', benchUrl: 'http://127.0.0.1:3/v/', eventStreamPath: '/tmp/e.jsonl',
    }));

    expect(unwatched).toContain(call);
    expect(watched).not.toContain('No watch reads');
  });

  it('leaves a template without the marker exactly as it was', () => {
    const a = getMessage('ELEMENT_NOT_FOUND', { selector: '.a' });
    const b = getMessage('ELEMENT_NOT_FOUND', { selector: '.a' });

    expect(a).toBe(b);
    expect(a).toContain('.a');
  });
});

describe('fixed text a reply repeats on every call', () => {
  it('carries a fixed sentence on the first reply and the reading alone after', () => {
    const first = textOf(createSuccessResponse('WAIT_SLEEP_COMPLETE', { ms: 200 }));
    const second = textOf(createSuccessResponse('WAIT_SLEEP_COMPLETE', { ms: 300 }));

    expect(first).toContain('Fixed sleeps are a last resort');
    expect(second).not.toContain('Fixed sleeps are a last resort');
    expect(second).toContain('Slept 300ms');
  });

  it('names the inactivity timeout once, with its minutes', () => {
    const first = withOnce('', 'CONNECTION_INACTIVITY_REPLY', { minutes: 60 });
    const second = withOnce('', 'CONNECTION_INACTIVITY_REPLY', { minutes: 60 });

    expect(first).toContain('auto-closes after 60 min');
    expect(second).toBe('');
  });

  it('gives a navigation hint once and its counts on every navigation', () => {
    const context = {
      url: 'http://localhost/', title: 't',
      clickableElements: { total: 4, inViewport: 3 },
      console: { errors: 1, warnings: 0, total: 1 },
      network: { failed: 2, total: 9 },
    };
    const first = formatPageContextForResponse(context, 'shop-web-app');
    const second = formatPageContextForResponse(context, 'shop-web-app');

    expect(first.clickableElements.hint).toContain("connection: 'shop-web-app'");
    expect(first.console.hint).toContain("type: 'error'");
    expect(first.network.hint).toContain('network({');
    expect(second.clickableElements.hint).toBeUndefined();
    expect(second.console.hint).toBeUndefined();
    expect(second.network.hint).toBeUndefined();
    expect(second.clickableElements.total).toBe(4);
    expect(second.network.failed).toBe(2);
  });

  it('renders every navigation reply clean once its hints have been shown', () => {
    const context = {
      url: 'http://localhost/', title: 't',
      clickableElements: { total: 4, inViewport: 3 },
      console: { errors: 1, warnings: 0, total: 1 },
      network: { failed: 2, total: 9 },
    };
    formatPageContextForResponse(context, 'nav-web-app');
    const later = formatPageContextForResponse(context, 'nav-web-app');
    for (const id of ['PAGE_NAVIGATE_SUCCESS', 'PAGE_RELOAD_SUCCESS', 'PAGE_GO_BACK_SUCCESS', 'PAGE_GO_FORWARD_SUCCESS']) {
      const out = textOf(createSuccessResponse(id, later));
      expect(out).not.toContain('{{');
      expect(out).toContain('2 failed requests of 9 total');
    }
  });

  it('names the watch on a send only where no watch reads the stream the reply lands on', () => {
    const call = 'Bash({ command: "devharness watch --session=a1b2c3d4", run_in_background: true })';
    const unwatched = textOf(createSuccessResponse('MESSAGE_SENT', { to: 'peer', shortId: 'abcd1234', mailboxPath: '/m/peer.jsonl', deliveryNote: '', watchCall: call }));
    const watched = textOf(createSuccessResponse('MESSAGE_SENT', { to: 'peer', shortId: 'abcd1234', mailboxPath: '/m/peer.jsonl', deliveryNote: '' }));

    expect(unwatched).toContain(call);
    expect(watched).not.toContain('which no watch reads');
  });
});

