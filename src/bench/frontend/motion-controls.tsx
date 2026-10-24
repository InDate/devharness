import type { MotionSetting } from '../kinds.js';

/** What a MOTION row's setting does on the next run, in words; undefined while it plays as the page has it. */
export function motionWords(setting: MotionSetting | undefined): string | undefined {
  if (!setting) return undefined;
  const words = [
    setting.off ? 'off' : '',
    setting.alone ? 'alone' : '',
    setting.freezeAt !== undefined ? `freezes at ${setting.freezeAt}ms${setting.only ? ', this one' : ''}` : '',
    setting.duration !== undefined ? `${setting.duration}ms` : '',
    setting.delay !== undefined ? `after ${setting.delay}ms` : '',
  ].filter(Boolean);
  return words.length ? `${words.join(', ')} next run` : undefined;
}

/** The page's own duration of an animation row, read off its line: `transition 420ms`. */
export function durationOf(preview: string | undefined): number {
  const match = /(\d+)ms/.exec(preview ?? '');
  return match ? Number(match[1]) : 0;
}

/** An animation's row: where its setting is stored, and whether a play can reach its step now. */
export interface MotionRow {
  base: string;
  step: number;
  kind: string;
  setting?: MotionSetting;
  /** The animation's own duration. */
  duration: number;
  /** A play to the step is out of reach while a run drives the page or a recording is open. */
  replayable: boolean;
}

export function postMotion(base: string, path: string, body: Record<string, unknown>): Promise<void> {
  return fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(() => undefined, () => undefined);
}
