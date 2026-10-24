/** @jsxImportSource preact */
import type { HeldStep } from '../wire.js';

/**
 * A step held while the agent reads it.
 *
 * Two states, and they are not the same thing to look at: while it is being
 * read there is nothing to answer, so the panel offers no action and says so;
 * once it is flagged the reason stands at the top, any selector it found is a
 * row to click, and keeping or dropping the step ends the hold.
 */
export function Held({ held, onChoose, onKeep, onDrop }: {
  held: HeldStep;
  onChoose: (index: number) => void;
  onKeep: () => void;
  onDrop: () => void;
}) {
  const flagged = held.verdict === 'flagged';
  return (
    <div class={flagged ? 'held flagged' : 'held'}>
      <div class="heldhead">
        {flagged ? (held.reason ?? held.label) : 'the agent is reading this step…'}
      </div>
      {!flagged && <p class="hint">the page is held while it reads. Nothing to do here yet.</p>}
      {flagged && held.detail && <div class="helddetail">{held.detail}</div>}
      {flagged && held.label !== held.reason && <div class="heldlabel">{held.label}</div>}

      {(held.options ?? []).map((option, index) => (
        <button key={option.selector} class="optrow" onClick={() => onChoose(index)}>
          <span class="optsel">{option.selector}</span>
          <span class="optnote">{option.note}</span>
        </button>
      ))}

      {flagged && (
        <div class="heldacts">
          <button class="chip-toggle" onClick={onDrop}>Drop step</button>
          <button class="save" onClick={onKeep}>Keep as recorded</button>
        </div>
      )}
    </div>
  );
}

