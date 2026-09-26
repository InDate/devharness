/** @jsxImportSource preact */
import type { FactKind } from '../wire.js';
import { useEscape } from './escape.js';

const FACTS: Array<[FactKind, string]> = [
  ['events', 'the handlers on it and on everything above it'],
  ['css', 'the rules that apply, computed values, box, what covers it, rendered font'],
  ['html', 'its markup, cut below three levels past 20 KB'],
  ['a11y', 'role, name and states as assistive technology reads them'],
];

/**
 * The capture dialog, over the whole bench while a capture is being chosen.
 *
 * The pick happens in the app's own tab, so covering the bench blocks nothing
 * the capture needs. The element path leads because it is the common one, and
 * the facts sit inside its panel since they are read only from an element.
 */
export function CaptureDialog({ heldBefore, facts, post, note }: {
  heldBefore: boolean;
  facts: FactKind[];
  /** The words of the note the capture joins, when opened from one. */
  note?: string;
  post: (path: string, body?: Record<string, unknown>) => Promise<void>;
}) {
  useEscape(true, () => void post('/shot/cancel'));

  const toggle = (kind: FactKind) => void post('/shot/facts', {
    kinds: facts.includes(kind) ? facts.filter(k => k !== kind) : [...facts, kind],
  });

  return (
    <div class="scrim capturescrim">
      <div class="report capturedialog" role="dialog" aria-label="screenshot">
        <h2 class="capturetitle">Screenshot active</h2>
        <p class="hint capturestate">{heldBefore ? 'page was already frozen' : 'page is frozen'}</p>
        {note !== undefined && <p class="capturenote">{note || '(no words)'}</p>}

        <section class="capturepick">
          <p>Click an element in the app window</p>
          <div class="capturefacts">
            <span class="hint">also record</span>
            {FACTS.map(([kind, says]) => (
              <label key={kind} title={says}>
                <input type="checkbox" checked={facts.includes(kind)} onChange={() => toggle(kind)} />
                {kind}
              </label>
            ))}
          </div>
        </section>

        <div class="capturerule"><span>or capture</span></div>

        <div class="capturewhole">
          <button class="save" title="what the window shows"
            onClick={() => void post('/shot', { kind: 'screen' })}>Screen</button>
          <button class="save" title="the whole document, below the fold too"
            onClick={() => void post('/shot', { kind: 'page' })}>Page</button>
          <button class="save" title="the whole document, with the window's place on it marked"
            onClick={() => void post('/shot', { kind: 'page', viewport: true })}>Page w/ VP</button>
        </div>

        <div class="capturefoot">
          <button class="tool" onClick={() => void post('/shot/cancel')}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
