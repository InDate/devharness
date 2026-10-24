/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import type { BurstView } from '../wire.js';
import { useEscape } from './escape.js';

/**
 * The frames a burst filmed from the person's input, in order, each with its
 * time from the input. The frame before the input is the screen as the input
 * found it, marked with a negative time. Keep leaves the frames on disk and
 * closes; drop deletes them.
 */
export function BurstSheet({ burst, base, post }: {
  burst: BurstView;
  base: string;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const frames = burst.frames ?? [];
  const keep = () => void post('/burst/dismiss', { drop: false });
  useEscape(true, () => { if (open !== null) setOpen(null); else keep(); });
  const src = (file: string) => `${base}/shot/img?p=${encodeURIComponent(file)}`;
  const time = (atMs: number) => `${atMs < 0 ? '-' : '+'}${Math.abs(atMs)}ms`;
  const shown = open !== null ? frames[open] : undefined;
  return (
    <div class="burstscrim">
      <div class="burstdialog" role="dialog" aria-label="burst">
        <div class="bursthead">
          <h2>Burst · {frames.length} frame{frames.length === 1 ? '' : 's'} · {burst.forMs ?? 500}ms from your {burst.trigger ?? 'input'}</h2>
          {shown && <button class="chip-toggle" onClick={() => setOpen(null)}>all frames</button>}
          <button class="chip-toggle keep" title="close, leaving the frames on disk" onClick={keep}>keep</button>
          <button class="chip-toggle bin" title="close and delete the frames" onClick={() => void post('/burst/dismiss', { drop: true })}>drop</button>
        </div>
        {shown ? (
          <div class="burstlarge">
            <img src={src(shown.file)} alt={`frame at ${time(shown.atMs)}`} />
            <span class="hint">frame {open! + 1} of {frames.length} · {time(shown.atMs)} · {shown.file}</span>
          </div>
        ) : frames.length === 0 ? (
          <p class="hint" style={{ padding: '12px' }}>Nothing on screen changed after your input, so no frame was drawn.</p>
        ) : (
          <div class="burstgrid">
            {frames.map((frame, k) => (
              <button key={frame.file} class={frame.atMs < 0 ? 'burstframe before' : 'burstframe'}
                title={frame.atMs < 0 ? 'the screen as your input found it' : 'open this frame'}
                onClick={() => setOpen(k)}>
                <img src={src(frame.file)} alt={`frame at ${time(frame.atMs)}`} loading="lazy" />
                <span>{time(frame.atMs)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
