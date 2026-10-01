import type { DiscMode } from '../wire.js';

/** Each state's colour, on the disc, its frame and a connection's dot alike. */
export const DISC_TONES: Record<DiscMode, string> = {
  recording: 'var(--alert)',
  frozen: 'var(--frost)',
  traffic: 'var(--caused)',
  playing: 'var(--sequence)',
  paused: 'color-mix(in srgb, var(--sequence) 50%, transparent)',
};

/** The disc's fill: one slice per standing state in order, or undefined while none stands. */
export function discFill(modes: readonly DiscMode[]): string | undefined {
  if (modes.length === 0) return undefined;
  const slice = 100 / modes.length;
  return `linear-gradient(90deg, ${modes.map((mode, k) => `${DISC_TONES[mode]} ${k * slice}% ${(k + 1) * slice}%`).join(', ')})`;
}

/** The states as the disc's title words them, 'idle' where none stands. */
export function discSaid(modes: readonly DiscMode[]): string {
  return modes.length
    ? modes.map(mode => (mode === 'frozen' ? 'page held' : mode === 'traffic' ? 'traffic held' : mode)).join(' · ')
    : 'idle';
}
