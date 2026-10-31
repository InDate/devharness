/**
 * The bench names a pointer step by what the press was. Under its action
 * alone, a hold, a double click and a right click on one element all read as
 * `input.click`.
 */

import { describe, it, expect } from 'vitest';
import { labelFor } from './sequence-driver.js';

const input = (params: Record<string, unknown>) => labelFor({ tool: 'input', params: { selector: '#box', ...params } });

describe('the bench label of a pointer step', () => {
  it.each([
    [{ action: 'click' }, 'input.leftClick #box'],
    [{ action: 'click', pressMs: 80 }, 'input.leftClick #box'],
    [{ action: 'click', pressMs: 800 }, 'input.pressAndHold #box'],
    [{ action: 'click', holdMs: 800 }, 'input.pressAndHold #box'],
    [{ action: 'click', clickCount: 2 }, 'input.doubleClick #box'],
    [{ action: 'click', clickCount: 3 }, 'input.tripleClick #box'],
    [{ action: 'click', button: 'right', modifiers: ['Meta'] }, 'input.rightClick #box'],
    [{ action: 'click', button: 'middle' }, 'input.middleClick #box'],
    [{ action: 'tap', pressMs: 16 }, 'input.tap #box'],
    [{ action: 'tap', pressMs: 800 }, 'input.longPress #box'],
    [{ action: 'tap', clickCount: 2 }, 'input.doubleTap #box'],
    [{ action: 'scroll', modifiers: ['Control'] }, 'input.trackpadPinch #box'],
    [{ action: 'scroll' }, 'input.scroll #box'],
  ])('%j reads as %s', (params, label) => {
    expect(input(params)).toBe(label);
  });

  it("reads a press as held against the sequence's threshold", () => {
    expect(labelFor({ tool: 'input', params: { action: 'click', selector: '#box', pressMs: 800 } }, 1000)).toBe('input.leftClick #box');
  });
});
