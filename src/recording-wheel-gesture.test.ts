/**
 * A recorded scroll as the gesture it was. A trackpad sends a wheel event
 * every 16ms; a step per event pays a step's own work between every event, so
 * a swipe replayed 3-10 times slower than it was made, and a sum of the events
 * replayed it as one jump. A recording gathers the events that follow one
 * another into one step, keeping each event's delta and the time before it.
 */

import { describe, it, expect } from 'vitest';
import { eventsToCommands, type InputEvent } from './interaction-recorder.js';
import { generatePlaywrightCode, generatePuppeteerCode } from './tools/replay-codegen.js';

const wheel = (at: number, deltaX: number, deltaY = 0): InputEvent => ({
  type: 'wheel', x: 618, y: 388, deltaX, deltaY, timestamp: 1000 + at, button: 0, buttons: 0,
} as InputEvent);

const click = (at: number): InputEvent => ({
  type: 'click', x: 10, y: 10, timestamp: 1000 + at, button: 0, buttons: 0, clickCount: 1, elementInfo: { selector: 'main' },
} as InputEvent);

const swipe = [click(-500), wheel(0, 1), wheel(16, 6), wheel(33, 7, -1), wheel(50, 12)];

describe('a recorded run of wheel events', () => {
  for (const simplify of [false, true]) {
    it(`becomes one scroll step carrying each event and the ms before it (simplify ${simplify})`, () => {
      const commands = eventsToCommands(swipe, { simplify, includeDelays: true });

      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual({
        tool: 'input',
        params: {
          action: 'scroll', x: 618, y: 388,
          events: [
            { deltaX: 1, deltaY: 0, afterMs: 0 },
            { deltaX: 6, deltaY: 0, afterMs: 16 },
            { deltaX: 7, deltaY: -1, afterMs: 17 },
            { deltaX: 12, deltaY: 0, afterMs: 17 },
          ],
        },
        delay: 500,
      });
    });
  }

  it('starts a new step after a quiet of more than 150ms, its delay counted from the first event of the step before', () => {
    const commands = eventsToCommands([wheel(0, 1), wheel(16, 2), wheel(1016, -2), wheel(1034, -1)], { includeDelays: true });

    expect(commands.map(c => c.params.events.length)).toEqual([2, 2]);
    expect(commands[1].delay).toBe(1016);
  });

  it('stays a plain scroll step when a lone event makes it up', () => {
    const commands = eventsToCommands([wheel(0, 0, 120)], { includeDelays: true });

    expect(commands).toEqual([{ tool: 'input', params: { action: 'scroll', x: 618, y: 388, deltaX: 0, deltaY: 120 } }]);
  });
});

describe('a gesture step in exported test code', () => {
  const step = {
    tool: 'input',
    params: { action: 'scroll', x: 618, y: 388, events: [{ deltaX: 1, afterMs: 0 }, { deltaX: 6, afterMs: 16 }] },
  };

  it('sends each event with the wait recorded before it, in Puppeteer', () => {
    const code = generatePuppeteerCode([step]);
    expect(code).toContain('await page.mouse.wheel({ deltaX: 1, deltaY: 0 });\n  await new Promise(resolve => setTimeout(resolve, 16));\n  await page.mouse.wheel({ deltaX: 6, deltaY: 0 });');
  });

  it('sends each event with the wait recorded before it, in Playwright', () => {
    const code = generatePlaywrightCode([step]);
    expect(code).toContain('await page.mouse.wheel(1, 0);\n  await page.waitForTimeout(16);\n  await page.mouse.wheel(6, 0);');
  });
});
