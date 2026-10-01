/** @jsxImportSource preact */
import type { ComponentChildren } from 'preact';
import { Glyph } from './glyph.js';

/**
 * What the bench needs a person to read, by what it asks of them: an error
 * says what failed, a warning what will fail, information what stands, and an
 * action what they have to do for the run to go on. The mark carries the kind,
 * so the words can be the message alone.
 */
export type NoticeKind = 'error' | 'warning' | 'info' | 'action';

export function Notice({ kind, title, children }: { kind: NoticeKind; title?: string; children: ComponentChildren }) {
  return (
    <div class={`notice ${kind}`} title={title} role={kind === 'error' || kind === 'action' ? 'alert' : 'status'}>
      <span class="noticemark"><Glyph of={kind} /></span>
      {children}
    </div>
  );
}
