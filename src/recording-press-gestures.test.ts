/**
 * A recorded press as the press it was. Every press used to record as one
 * quick left click: a hold, a double click, a right or middle click and a
 * modified click replayed alike, and touch, HTML5 drag and trackpad pinch
 * recorded nothing or the wrong step. The event orders here are the ones
 * Chrome delivers, read off the gestures test page.
 */

import { describe, it, expect } from 'vitest';
import { eventsToCommands, type InputEvent, type TouchPoint } from './interaction-recorder.js';

const target = (selector: string) => ({ tag: 'div', selector });

const mouse = (type: string, at: number, extra: Record<string, unknown> = {}): InputEvent => ({
  type, x: 100, y: 100, timestamp: 1000 + at, button: 0, buttons: 0, elementInfo: target('#box'), ...extra,
} as InputEvent);

/** A left press held `ms` and released, and the click Chrome fires after it. */
const press = (at: number, ms: number, extra: Record<string, unknown> = {}): InputEvent[] => [
  mouse('mousedown', at, extra), mouse('mouseup', at + ms, extra), mouse('click', at + ms, { clickCount: 1, ...extra }),
];

const touch = (type: string, at: number, touches: TouchPoint[], changed: TouchPoint[] = touches, selector = '#pad'): InputEvent => ({
  type, timestamp: 1000 + at, touches, changed, ...(type === 'touchstart' ? { elementInfo: target(selector) } : {}),
} as InputEvent);

const at = (id: number, x: number, y: number): TouchPoint => ({ id, x, y });

describe('a recorded mouse press', () => {
  it('stores how long it was pressed on the click step', () => {
    expect(eventsToCommands(press(0, 800))).toEqual([
      { tool: 'input', params: { action: 'click', selector: '#box', pressMs: 800 } },
    ]);
  });

  it("records a person's double click, two presses with detail 1 then 2, as one click with clickCount 2", () => {
    const events = [
      ...press(0, 60),
      mouse('mousedown', 120), mouse('mouseup', 180), mouse('click', 180, { clickCount: 2 }), mouse('dblclick', 180, { clickCount: 2 }),
    ];

    expect(eventsToCommands(events)).toEqual([{ tool: 'input', params: { action: 'click', selector: '#box', clickCount: 2 } }]);
  });

  it("records CDP's double click, one press with detail 2, as one click with clickCount 2", () => {
    const events = [mouse('mousedown', 0), mouse('mouseup', 0), mouse('click', 0, { clickCount: 2 }), mouse('dblclick', 0, { clickCount: 2 })];

    expect(eventsToCommands(events)).toEqual([{ tool: 'input', params: { action: 'click', selector: '#box', clickCount: 2 } }]);
  });

  it('extends a double click to clickCount 3 on a third press', () => {
    const events = [
      ...press(0, 50),
      mouse('mousedown', 100), mouse('mouseup', 150), mouse('click', 150, { clickCount: 2 }), mouse('dblclick', 150, { clickCount: 2 }),
      mouse('mousedown', 200), mouse('mouseup', 250), mouse('click', 250, { clickCount: 3 }),
    ];

    expect(eventsToCommands(events)).toEqual([{ tool: 'input', params: { action: 'click', selector: '#box', clickCount: 3 } }]);
  });

  it('records a right click from its contextmenu, which macOS fires between the press and the release', () => {
    const events = [mouse('mousedown', 0, { button: 2 }), mouse('contextmenu', 5, { button: 2 }), mouse('mouseup', 90, { button: 2 })];

    expect(eventsToCommands(events)).toEqual([{ tool: 'input', params: { action: 'click', selector: '#box', button: 'right' } }]);
  });

  it('records a macOS Control-click, a contextmenu from the left button, as a right click without the Control', () => {
    const events = [
      mouse('mousedown', 0, { modifiers: { ctrl: true } }),
      mouse('contextmenu', 5, { modifiers: { ctrl: true } }),
      mouse('mouseup', 90, { modifiers: { ctrl: true } }),
    ];

    expect(eventsToCommands(events)).toEqual([{ tool: 'input', params: { action: 'click', selector: '#box', button: 'right' } }]);
  });

  it('records a middle press, which fires auxclick and no click, as a middle click', () => {
    const events = [mouse('mousedown', 0, { button: 1 }), mouse('mouseup', 80, { button: 1 })];

    expect(eventsToCommands(events)).toEqual([{ tool: 'input', params: { action: 'click', selector: '#box', button: 'middle' } }]);
  });

  it('carries the keys held through the press', () => {
    expect(eventsToCommands(press(0, 70, { modifiers: { shift: true, meta: true } }))).toEqual([
      { tool: 'input', params: { action: 'click', selector: '#box', modifiers: ['Shift', 'Meta'], pressMs: 70 } },
    ]);
  });

  it('records an HTML5 drag, which sends no mouseup, as a drag from the press to the drop', () => {
    const events = [
      mouse('mousedown', 0, { x: 130, y: 410 }),
      { type: 'dragstart', timestamp: 1010, point: { x: 134, y: 410 }, elementInfo: target('#drag-a') },
      { type: 'drop', timestamp: 1400, point: { x: 455, y: 410 }, elementInfo: target('#drop-zone') },
      { type: 'dragend', timestamp: 1401, point: { x: 455, y: 410 }, elementInfo: target('#drag-a') },
    ] as InputEvent[];

    expect(eventsToCommands(events)).toEqual([
      { tool: 'input', params: { action: 'drag', from: { x: 130, y: 410 }, to: { x: 455, y: 410 } } },
    ]);
  });
});

describe('a recorded wheel gesture with keys held', () => {
  const wheel = (offset: number, ctrl: boolean): InputEvent => mouse('wheel', offset, { deltaY: -40, ...(ctrl ? { modifiers: { ctrl: true } } : {}) });

  it('records a trackpad pinch, wheel events with Control, as a scroll carrying the Control', () => {
    const [step] = eventsToCommands([wheel(0, true), wheel(16, true)]);

    expect(step.params).toMatchObject({ action: 'scroll', modifiers: ['Control'] });
    expect(step.params.events).toHaveLength(2);
  });

  it('starts a new step where the keys held change', () => {
    const steps = eventsToCommands([wheel(0, false), wheel(16, false), wheel(32, true), wheel(48, true)]);

    expect(steps.map(step => step.params.modifiers)).toEqual([undefined, ['Control']]);
  });
});

describe('a recorded touch gesture', () => {
  it('records one contact that stays put as a tap with how long it was down', () => {
    const events = [touch('touchstart', 0, [at(7, 150, 98)]), touch('touchend', 800, [], [at(7, 150, 98)])];

    expect(eventsToCommands(events)).toEqual([{ tool: 'input', params: { action: 'tap', selector: '#pad', pressMs: 800 } }]);
  });

  it('records two quick taps on one spot as a tap with clickCount 2', () => {
    const events = [
      touch('touchstart', 0, [at(1, 280, 160)]), touch('touchend', 16, [], [at(1, 280, 160)]),
      touch('touchstart', 100, [at(2, 282, 159)]), touch('touchend', 116, [], [at(2, 282, 159)]),
    ];

    expect(eventsToCommands(events)).toEqual([{ tool: 'input', params: { action: 'tap', selector: '#pad', clickCount: 2 } }]);
  });

  it('records one contact that travels as a swipe over the time it moved', () => {
    const events = [
      touch('touchstart', 0, [at(1, 100, 300)]),
      touch('touchmove', 16, [at(1, 140, 300)]),
      touch('touchmove', 32, [at(1, 200, 300)]),
      touch('touchend', 40, [], [at(1, 200, 300)]),
    ];

    expect(eventsToCommands(events)).toEqual([{
      tool: 'input',
      params: { action: 'swipe', from: { x: 100, y: 300 }, to: { x: 200, y: 300 }, durationMs: 32, steps: 2 },
    }]);
  });

  it('records two contacts spreading as a pinch whose frames number the contacts in the order they landed', () => {
    const events = [
      touch('touchstart', 0, [at(41, 380, 277)]),
      touch('touchstart', 20, [at(41, 380, 277), at(42, 420, 277)], [at(42, 420, 277)]),
      touch('touchmove', 36, [at(41, 320, 277), at(42, 480, 277)]),
      touch('touchend', 52, [at(42, 480, 277)], [at(41, 320, 277)]),
      touch('touchend', 52, [], [at(42, 480, 277)]),
    ];

    expect(eventsToCommands(events)).toEqual([{
      tool: 'input',
      params: {
        action: 'pinch',
        frames: [
          { afterMs: 0, points: [at(0, 380, 277)] },
          { afterMs: 20, points: [at(0, 380, 277), at(1, 420, 277)] },
          { afterMs: 16, points: [at(0, 320, 277), at(1, 480, 277)] },
          { afterMs: 16, points: [at(1, 480, 277)] },
          { afterMs: 0, points: [] },
        ],
      },
    }]);
  });

  it('records two contacts whose line turns past 15 degrees as a rotate', () => {
    const events = [
      touch('touchstart', 0, [at(1, 380, 277)]),
      touch('touchstart', 20, [at(1, 380, 277), at(2, 420, 277)], [at(2, 420, 277)]),
      touch('touchmove', 36, [at(1, 374, 246), at(2, 426, 308)]),
      touch('touchend', 52, [], [at(1, 374, 246), at(2, 426, 308)]),
    ];

    expect(eventsToCommands(events)[0].params.action).toBe('rotate');
  });
});
