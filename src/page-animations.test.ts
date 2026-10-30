import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { ANIMATIONS_KEY, PAGE_ANIMATIONS_SOURCE } from './page-animations.js';
import { PAGE_CLOCK_SOURCE, CLOCK_KEY } from './page-clock.js';

/** An animation object as the page's own list hands it out, with the controls the record acts through. */
function fakeAnimation(props: { transitionProperty?: string; animationName?: string; target?: any; duration?: number; delay?: number; easing?: string; keyframes?: Record<string, unknown>[] }) {
  const timing = { duration: props.duration ?? 300, delay: props.delay ?? 0, easing: props.easing ?? 'ease' };
  return {
    ...(props.transitionProperty !== undefined ? { transitionProperty: props.transitionProperty } : {}),
    ...(props.animationName !== undefined ? { animationName: props.animationName } : {}),
    playState: 'running',
    currentTime: 0 as number | null,
    effect: {
      target: props.target,
      getComputedTiming: () => ({ duration: timing.duration, delay: timing.delay, iterations: 1 }),
      getTiming: () => ({ easing: timing.easing }),
      getKeyframes: () => props.keyframes ?? [],
      updateTiming: (next: { duration?: number; delay?: number }) => Object.assign(timing, next),
    },
    pause() { this.playState = 'paused'; },
    play() { this.playState = 'running'; },
  };
}

function element(tagName: string, opts: { id?: string; className?: string; shadow?: any } = {}) {
  return { tagName: tagName.toUpperCase(), id: opts.id ?? '', className: opts.className ?? '', shadowRoot: opts.shadow ?? null };
}

/** A page whose document and shadow roots list what the test sets on them, with the animation list put in. */
function pageWithAnimations() {
  const documentList: any[] = [];
  const shadowList: any[] = [];
  const shadow = { getAnimations: () => [...shadowList], querySelectorAll: () => [] };
  const host = element('div', { id: 'host', shadow });
  const page: any = {
    document: { getAnimations: () => [...documentList], querySelectorAll: () => [host] },
  };
  page.globalThis = page;
  vm.createContext(page);
  vm.runInContext(PAGE_ANIMATIONS_SOURCE, page);
  const animations = vm.runInContext(`globalThis[Symbol.for('${ANIMATIONS_KEY}')]`, page);
  return { page, animations, documentList, shadowList };
}

describe('the page\'s own animation list', () => {
  it('reads a transition\'s start and end values from its keyframes, keyed by the property in camel case', () => {
    const { animations, documentList } = pageWithAnimations();
    documentList.push(fakeAnimation({
      transitionProperty: 'stroke-dashoffset', target: element('path'),
      keyframes: [{ offset: 0, strokeDashoffset: '24' }, { offset: 1, strokeDashoffset: '0' }],
    }));
    documentList.push(fakeAnimation({ animationName: 'rise', target: element('h2'), keyframes: [{ offset: 0, opacity: '0' }, { offset: 1, opacity: '1' }] }));

    const [transition, keyframed] = animations.sweep().created;

    expect(transition).toMatchObject({ name: 'stroke-dashoffset', from: '24', to: '0' });
    expect(keyframed.from).toBeUndefined();
    expect(keyframed.to).toBeUndefined();
  });

  it('reports each animation once, named by what animates and on which element', () => {
    const { animations, documentList } = pageWithAnimations();
    documentList.push(fakeAnimation({ transitionProperty: 'opacity', target: element('div', { id: 'toast' }), duration: 1000 }));
    documentList.push(fakeAnimation({ transitionProperty: 'transform', target: element('div', { className: 'item open extra' }), delay: 120 }));

    const first = animations.sweep();
    const second = animations.sweep();

    expect(first.created).toEqual([
      expect.objectContaining({ id: 1, name: 'opacity', type: 'CSSTransition', element: '#toast', duration: 1000, delay: 0 }),
      expect.objectContaining({ id: 2, name: 'transform', type: 'CSSTransition', element: 'div.item.open', duration: 300, delay: 120 }),
    ]);
    expect(second.created).toEqual([]);
  });

  it('lists the animations in an open shadow root, which the document\'s list leaves out', () => {
    const { animations, shadowList } = pageWithAnimations();
    shadowList.push(fakeAnimation({ animationName: 'spin', target: element('span', { className: 'dot' }) }));

    expect(animations.sweep().created).toEqual([expect.objectContaining({ name: 'spin', type: 'CSSAnimation', element: 'span.dot' })]);
  });

  it('names an element inside a shadow root through its host', () => {
    const { animations, shadowList } = pageWithAnimations();
    const chip = { ...element('mail-chip', { id: 'chip' }), getRootNode: () => ({}) };
    const pill = { ...element('span', { className: 'ping' }), getRootNode: () => ({ host: chip }) };
    shadowList.push(fakeAnimation({ animationName: 'ping', target: pill }));

    expect(animations.sweep().created).toEqual([expect.objectContaining({ name: 'ping', element: '#chip › span.ping' })]);
  });

  it('reports an animation gone from the list, finished or cancelled', () => {
    const { animations, documentList } = pageWithAnimations();
    const done = fakeAnimation({ transitionProperty: 'opacity' });
    const cut = fakeAnimation({ transitionProperty: 'width' });
    documentList.push(done, cut);
    animations.sweep();

    done.playState = 'finished';
    cut.playState = 'idle';
    documentList.length = 0;

    expect(animations.sweep().gone).toEqual([{ id: 1, how: 'finished' }, { id: 2, how: 'canceled' }]);
  });

  it('names an animation a start report brought in once, under the id the sweep then keeps', () => {
    const { animations, documentList } = pageWithAnimations();
    const reported = fakeAnimation({ transitionProperty: 'opacity' });

    const fromReport = animations.idOf(reported);
    documentList.push(reported);
    const swept = animations.sweep();
    reported.playState = 'finished';
    documentList.length = 0;

    expect(swept.created).toEqual([]);
    expect(animations.sweep().gone).toEqual([{ id: fromReport, how: 'finished' }]);
  });

  it('seeks, pauses, plays and retimes an animation by its id', () => {
    const { animations, documentList } = pageWithAnimations();
    const animation = fakeAnimation({ transitionProperty: 'opacity', duration: 1000 });
    documentList.push(animation);
    const [{ id }] = animations.sweep().created;

    animations.seek(id, 250);
    animations.pause(id);
    expect(animations.read(id)).toEqual(expect.objectContaining({ currentTime: 250, playState: 'paused' }));

    animations.play(id);
    animations.retime(id, { duration: 400, delay: 50 });
    expect(animations.read(id)).toEqual(expect.objectContaining({ playState: 'running', duration: 400, delay: 50 }));
  });
});

describe('the clock\'s held steps', () => {
  it('hand back what a frame created', () => {
    const list: any[] = [];
    const page: any = {
      document: { getAnimations: () => [...list], querySelectorAll: () => [], documentElement: { offsetWidth: 0 } },
      performance: { now: () => 1000 },
      Date, setTimeout: () => 1, clearTimeout: () => {},
      requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
    };
    page.globalThis = page;
    vm.createContext(page);
    vm.runInContext(PAGE_CLOCK_SOURCE, page);
    vm.runInContext(PAGE_ANIMATIONS_SOURCE, page);
    const clock = vm.runInContext(`globalThis[Symbol.for('${CLOCK_KEY}')]`, page);
    clock.pause();
    clock.holdFrames();
    page.requestAnimationFrame(() => list.push(fakeAnimation({ transitionProperty: 'opacity', target: element('div', { id: 'toast' }) })));

    const stepped = clock.frame(16.7);

    expect(stepped.animations.created).toEqual([expect.objectContaining({ name: 'opacity', element: '#toast' })]);
  });
});
