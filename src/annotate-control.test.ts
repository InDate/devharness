/**
 * Tests for the control pane's own behaviour.
 *
 * The pane polls four times a second. Anything it redraws on every poll
 * replaces the controls inside it, and a click whose press and release land
 * either side of a redraw never becomes a click - the button looks dead while
 * every handler behind it is correct.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PAGE } from './annotate-control.js';

declare const document: any;

/** The pane's script, with its network calls captured rather than made. */
function loadPane() {
  const script = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.lastIndexOf('</script>'));
  document.body.innerHTML = PAGE.slice(PAGE.indexOf('<body>') + 6, PAGE.indexOf('</body>'));
  const posts: Array<{ path: string; body: any }> = [];
  // The pane declares BASE and post() itself; both are replaced here so the
  // script runs without a server behind it.
  const body = script
    .replace(/const BASE = [^;]+;/, 'const BASE = "/t";')
    .replace(/async function post\([\s\S]*?\n}/, 'async function post(path, payload) { POSTS.push({ path, body: payload }); }');
  // happy-dom has no Option constructor; the pane uses it to fill the dropdown.
  const Option = function (this: any, text: string, value: string) {
    const option = document.createElement('option');
    option.textContent = text;
    option.value = value;
    return option;
  } as any;
  const fn = new Function('POSTS', 'fetch', 'setInterval', 'Option', body + '\nreturn { render, renderSequence };');
  const api = fn(posts, async () => ({ ok: true, json: async () => ({}) }), () => 0, Option);
  return { ...api, posts };
}

const sequenceState = (annotationId: string) => ({
  available: ['orders'],
  name: 'orders',
  currentStep: 1,
  total: 2,
  busy: false,
  variables: [],
  steps: [
    { index: 0, label: 'navigate.goto /orders', done: true, current: false },
    {
      index: 1,
      label: 'input.click #save',
      done: false,
      current: true,
      annotations: [{
        id: annotationId,
        at: '2026-09-17T00:00:00.000Z',
        url: 'http://localhost:5173/orders',
        tick: 0,
        comment: 'pill never clears',
        target: { tag: 'span', selector: '.pill' },
      }],
    },
  ],
});

beforeEach(() => { document.body.innerHTML = ''; });

describe("the pane step list", () => {
  it('leaves the list alone when the poll brings back the same steps', () => {
    const pane = loadPane();
    pane.renderSequence(sequenceState('note-1'), undefined);
    const button = document.querySelector('.ndrop');
    expect(button).not.toBeNull();

    pane.renderSequence(sequenceState('note-1'), undefined);

    // Same node, so a click started before the poll still completes on it.
    expect(document.querySelector('.ndrop')).toBe(button);
  });

  it('rebuilds once a note is added, so the new one shows', () => {
    const pane = loadPane();
    pane.renderSequence(sequenceState('note-1'), undefined);
    const before = document.querySelector('.ndrop');

    const withSecond: any = sequenceState('note-1');
    withSecond.steps[1].annotations.push({
      id: 'note-2', at: '2026-09-17T00:01:00.000Z', url: 'u', tick: 0,
      comment: 'and this', target: { tag: 'span', selector: '.other' },
    });
    pane.renderSequence(withSecond, undefined);

    expect(document.querySelectorAll('.ndrop')).toHaveLength(2);
    expect(document.querySelector('.ndrop')).not.toBe(before);
  });

  it('holds the selector in the note\'s own slot, not below it', () => {
    // Placed below, revealing it would grow the row and shift everything under
    // the pointer. In the slot the comment keeps its space and the row's height
    // never changes.
    const pane = loadPane();
    pane.renderSequence(sequenceState('note-1'), undefined);

    const slot = document.querySelector('.ntext');
    expect(slot.querySelector('.ncomment').textContent).toBe('pill never clears');
    expect(slot.querySelector('.nsel').textContent).toBe('.pill');
    expect(document.querySelector('.note > .nsel')).toBeNull();
  });

  it('opens with what the note says and the element it names', () => {
    const pane = loadPane();
    const state: any = sequenceState('note-1');
    state.steps[1].annotations[0].screenshots = ['/tmp/shots/a.png', '/tmp/shots/b.png'];
    pane.renderSequence(state, undefined);
    const thumbs = document.querySelectorAll('.nshots img');
    expect(thumbs).toHaveLength(2);
    expect(document.getElementById('shotModal').hidden).toBe(true);

    thumbs[1].dispatchEvent(new (globalThis as any).Event('click'));

    expect(document.getElementById('shotModal').hidden).toBe(false);
    expect(document.getElementById('shotModalTitle').textContent).toBe('pill never clears');
    expect(document.getElementById('shotModalSel').textContent).toBe('.pill');
  });

  it('holds every capture at once, to be scrolled rather than swapped', () => {
    const pane = loadPane();
    const state: any = sequenceState('note-1');
    state.steps[1].annotations[0].screenshots = ['/tmp/shots/a.png', '/tmp/shots/b.png'];
    pane.renderSequence(state, undefined);

    document.querySelectorAll('.nshots img')[0].dispatchEvent(new (globalThis as any).Event('click'));

    const shown = document.querySelectorAll('#shotModalImages img');
    expect(shown).toHaveLength(2);
    expect(shown[0].src).toContain(encodeURIComponent('/tmp/shots/a.png'));
    expect(shown[1].src).toContain(encodeURIComponent('/tmp/shots/b.png'));
    expect(document.querySelector('.mstrip')).toBeNull();
  });

  it('names each capture and its place in the set', () => {
    const pane = loadPane();
    const state: any = sequenceState('note-1');
    state.steps[1].annotations[0].screenshots = ['/tmp/shots/a.png', '/tmp/shots/b.png'];
    pane.renderSequence(state, undefined);

    document.querySelectorAll('.nshots img')[0].dispatchEvent(new (globalThis as any).Event('click'));

    const captions = [...document.querySelectorAll('#shotModalImages figcaption')].map(c => c.textContent);
    expect(captions[0]).toContain('a.png');
    expect(captions[0]).toContain('1 of 2');
    expect(captions[1]).toContain('2 of 2');
  });

  it('leaves the count off a note carrying one capture', () => {
    const pane = loadPane();
    const state: any = sequenceState('note-1');
    state.steps[1].annotations[0].screenshots = ['/tmp/shots/only.png'];
    pane.renderSequence(state, undefined);

    document.querySelector('.nshots img').dispatchEvent(new (globalThis as any).Event('click'));

    expect(document.querySelectorAll('#shotModalImages img')).toHaveLength(1);
    expect(document.querySelector('#shotModalImages figcaption').textContent).toBe('only.png');
  });

  it('keeps every hidden element hidden, whatever display it sets', () => {
    // A rule carrying an id or class outranks the browser's own [hidden], and
    // an overlay that ignores hidden covers the pane from the moment it loads.
    const style = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
    expect(style).toContain('[hidden] { display: none !important; }');
  });

  it('shows no strip for a note with no captures', () => {
    const pane = loadPane();
    pane.renderSequence(sequenceState('note-1'), undefined);

    expect(document.querySelector('.nshots')).toBeNull();
  });

  it('sends the note id when its delete is clicked', () => {
    const pane = loadPane();
    pane.renderSequence(sequenceState('note-1'), undefined);

    document.querySelector('.ndrop').dispatchEvent(new (globalThis as any).Event('click'));

    expect(pane.posts).toContainEqual({ path: '/annotation/delete', body: { id: 'note-1' } });
  });
});
