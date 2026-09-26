/** @jsxImportSource preact */
import { useState } from 'preact/hooks';
import { Held as HeldStepPanel } from './recording.js';
import type { SequenceState } from '../wire.js';

type Post = (path: string, body?: Record<string, unknown>) => Promise<void>;

/**
 * What a recording under way carries beyond its steps: what it is for, and a
 * step the agent holds. Its name, its count and the two ways to end it are
 * on the footing and the screen's frame says it is recording, so a recording
 * with neither of these draws nothing here.
 */
export function RecordingRow({ sequence, post }: { sequence: SequenceState; post: Post }) {
  const purposed = !!(sequence.description?.trim() || sequence.expectedOutcome?.trim());
  if (!purposed && !sequence.pendingStep) return null;
  return (
    <div class="reccard">
      <PurposeRow label="for" value={sequence.description ?? ''}
        onSave={(description) => void post('/sequence/describe', { description, expectedOutcome: sequence.expectedOutcome ?? '' })} />
      <PurposeRow label="ends when" value={sequence.expectedOutcome ?? ''}
        onSave={(expectedOutcome) => void post('/sequence/describe', { description: sequence.description ?? '', expectedOutcome })} />
      {sequence.pendingStep && (
        <HeldStepPanel
          held={sequence.pendingStep}
          onChoose={(index) => void post('/sequence/record/choose', { index })}
          onKeep={() => void post('/sequence/record/keep')}
          onDrop={() => void post('/sequence/record/drop')}
        />
      )}
    </div>
  );
}

/**
 * One line of what the recording is for, shown once it says something and
 * changed in place by the pen. Empty, it stays out of the way.
 */
function PurposeRow({ label, value, onSave }: { label: string; value: string; onSave: (next: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!value.trim() && !editing) return null;
  const done = (save: boolean) => {
    if (save && draft.trim() !== value) onSave(draft.trim());
    setEditing(false);
  };
  return (
    <div class="replrow">
      <span class="repllabel">{label}</span>
      {editing
        ? <input class="recinput" value={draft} ref={(box) => box?.focus()}
            onInput={(e: Event) => setDraft((e.target as HTMLInputElement).value)}
            onBlur={() => done(true)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter') done(true);
              if (e.key === 'Escape') { setDraft(value); done(false); }
            }} />
        : <>
            <span class="recvalue">{value}</span>
            <button class="tool plain" title={`change what it is ${label}`} onClick={() => { setDraft(value); setEditing(true); }}>✎</button>
          </>}
    </div>
  );
}
