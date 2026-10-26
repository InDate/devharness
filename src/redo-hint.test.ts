/**
 * A call that redoes an entry in this session's history: found, and named
 * with the repeat call that does the same, on the session's first such redo.
 */
import { describe, it, expect } from 'vitest';
import { findRedo, repeatCall, redoNote } from './redo-hint.js';

const expression = "(() => { const t = document.getElementById('toast'); return { text: t.textContent, opacity: t.style.opacity }; })()";
const entry = (index: number, tool: string, params: Record<string, unknown>) => ({ index, tool, params, timestamp: index }) as any;
const history = [
  entry(1, 'navigate', { action: 'reload', connection: 'shop-web-app' }),
  entry(2, 'inspect', { action: 'evaluateExpression', connection: 'shop-web-app', expression }),
  entry(3, 'input', { action: 'click', connection: 'shop-web-app', selector: 'button:has-text("Save")' }),
];

describe('a call that redoes one in history', () => {
  it('finds an exact redo and names repeat with its index', () => {
    const redo = findRedo(history, 'inspect', { action: 'evaluateExpression', connection: 'shop-web-app', expression }, 4);

    expect(redo).toEqual({ index: 2, changed: {} });
    expect(repeatCall(redo!)).toBe("run({ action: 'repeat', indices: [2] })");
  });

  it('finds an edit of one field and names repeat with that field in params', () => {
    const edited = expression.replace('opacity: t.style.opacity', 'opacity: t.style.opacity, shown: true');
    const redo = findRedo(history, 'inspect', { action: 'evaluateExpression', connection: 'shop-web-app', expression: edited }, 4);

    expect(redo?.index).toBe(2);
    expect(repeatCall(redo!)).toContain('params: {"expression":');
  });

  it('leaves a short call alone, since retyping it costs no more than the repeat', () => {
    expect(findRedo(history, 'navigate', { action: 'reload', connection: 'shop-web-app' }, 4)).toBeUndefined();
  });

  it('leaves a new call alone: another tool, other fields, or a value changed past recognition', () => {
    expect(findRedo(history, 'dom', { action: 'evaluateExpression', connection: 'shop-web-app', expression }, 4)).toBeUndefined();
    expect(findRedo(history, 'inspect', { action: 'evaluateExpression', connection: 'shop-web-app', expression, awaitPromise: false }, 4)).toBeUndefined();
    expect(findRedo(history, 'inspect', { action: 'evaluateExpression', connection: 'shop-web-app', expression: 'Array.from(document.querySelectorAll("li")).map(li => li.dataset.id).join(",")' }, 4)).toBeUndefined();
  });

  it('names the repeat on the session\'s first redo, and nothing on the next', () => {
    const params = { action: 'click', connection: 'shop-web-app', selector: 'button:has-text("Save")' };
    const first = redoNote(history, 'input', { ...params, selector: 'button:has-text("Save")' }, 4);
    const second = redoNote(history, 'input', params, 5);

    expect(first).toContain('This call repeats history entry #3');
    expect(first).toContain("run({ action: 'repeat', indices: [3] })");
    expect(second).toBe('');
  });
});
