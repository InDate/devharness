import { describe, it, expect } from 'vitest';
import { PageTime, attachPageTime } from './page-time.js';
import { forgetConnection, recordHeld, recordReleased } from './hold.js';

/** A page time over a session that logs each command as the CSS rate or the clock control it is. */
function timeWithLog() {
  const log: string[] = [];
  const time = new PageTime('app', {
    send: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Animation.setPlaybackRate') log.push(`css ${params?.playbackRate}`);
      if (method === 'Runtime.evaluate') log.push(`clock ${/\]\?\.([a-zA-Z]+)\(/.exec(String(params?.expression))?.[1]}`);
      return { result: { value: true } };
    },
  });
  return { time, log };
}

describe('page time - the clock and the CSS rate driven together', () => {
  it('stops the CSS animations and the clock, and starts them again at the page speed', async () => {
    const { time, log } = timeWithLog();

    await time.stop();
    expect(time.stopped).toBe(true);
    await time.start();

    expect(log).toEqual(['css 0', 'clock pause', 'clock resume', 'css 1']);
    expect(time.stopped).toBe(false);
  });

  it('keeps a speed set while stopped for the CSS until time starts, and gives it to the clock now', async () => {
    const { time, log } = timeWithLog();
    await time.stop();
    log.length = 0;

    await time.setRate(0.25);
    expect(log).toEqual(['clock rate']);
    await time.start();

    expect(log).toEqual(['clock rate', 'clock resume', 'css 0.25']);
    expect(time.playbackRate).toBe(0.25);
  });

  it('answers nothing for a page with no clock, and goes on', async () => {
    const time = new PageTime('app', { send: async () => ({ result: {} }) });

    expect(await time.holdFrames()).toBe(false);
    expect(await time.frame(16.7)).toBeUndefined();
    expect(await time.reading()).toBeUndefined();
  });
});

describe('page time follows the page\'s stops', () => {
  /** A page time attached with a pause watch the test fires, logging its clock controls. */
  function attached() {
    const log: string[] = [];
    let fire: (paused: boolean) => void = () => {};
    const detach = attachPageTime('followed', {
      send: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') log.push(/\]\?\.([a-zA-Z]+)\(/.exec(String(params?.expression))?.[1] ?? '');
        return { result: {} };
      },
    }, watcher => { fire = watcher; return () => {}; });
    return { log, fire: (paused: boolean) => fire(paused), done: () => { detach(); forgetConnection('followed'); } };
  }

  it('stops page time when the page stops under a hold of devharness\'s, and runs it when none is left', async () => {
    const { log, fire, done } = attached();
    recordHeld('followed', 'code', 'tool');
    fire(true);
    recordReleased('followed', 'code');
    fire(false);
    await new Promise(r => setTimeout(r, 0));
    expect(log).toEqual(['pause', 'resume']);
    done();
  });

  it('leaves page time running through someone else\'s breakpoint', async () => {
    const { log, fire, done } = attached();
    recordHeld('followed', 'code', 'breakpoint');
    fire(true);
    await new Promise(r => setTimeout(r, 0));
    expect(log).toEqual([]);
    done();
  });

  it('keeps page time stopped across a resume that leaves a hold standing, as a step does', async () => {
    const { log, fire, done } = attached();
    recordHeld('followed', 'ui', 'bench');
    fire(false);
    await new Promise(r => setTimeout(r, 0));
    expect(log).toEqual([]);
    done();
  });
});
