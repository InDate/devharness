import { describe, it, expect } from 'vitest';
import { comparisonOf } from './check-words.js';

describe('comparisonOf', () => {
  it('reads a class or id holding a comparison word as the selector it is', () => {
    expect(comparisonOf('check', { selector: '.visible-toast', condition: 'absent' })).toEqual(['absent', 'present']);
    expect(comparisonOf('check', { selector: '#gt-banner', condition: 'present' })).toEqual(['present', 'absent']);
    expect(comparisonOf('check', { selector: '.toast.enabled', condition: 'absent' })).toEqual(['absent', 'present']);
  });

  it('reads an expression as true or false, whatever words it holds', () => {
    expect(comparisonOf('check', { expression: "document.body.classList.contains('ready')" })).toEqual(['true', 'false']);
  });

  it('reads a presence check on :has-text() as found, for a check as for a wait', () => {
    expect(comparisonOf('check', { selector: 'button:has-text("OK")', condition: 'present' })).toEqual(['found', 'not found']);
    expect(comparisonOf('wait', { selector: 'button:has-text("OK")' })).toEqual(['found', 'not found']);
  });

  it('reads a comparing check by its operator', () => {
    expect(comparisonOf('check', { selector: '#state', condition: 'text', operator: 'equals', right: 'open' })).toEqual(['equals', 'not equal']);
    expect(comparisonOf('assert', { selector: '#state', condition: 'text', operator: 'equals', right: 'open' })).toEqual(['equals', 'not equal']);
    expect(comparisonOf('assert', { left: '{{var:visible}}', operator: 'matches', right: '^s-' })).toEqual(['matches', 'no match']);
  });

  it('reads a timer as waited, a length of 0 included', () => {
    expect(comparisonOf('check', { afterMs: 1000 })).toEqual(['waited', 'waited']);
    expect(comparisonOf('wait', { ms: 0 })).toEqual(['waited', 'waited']);
  });

  it('reads a wait for something to go as absent, and storage by its condition', () => {
    expect(comparisonOf('wait', { selectorGone: '.spinner' })).toEqual(['absent', 'present']);
    expect(comparisonOf('check', { localStorage: 'token', condition: 'absent' })).toEqual(['absent', 'present']);
    expect(comparisonOf('check', { url: '/app', operator: 'contains' })).toEqual(['contains', 'missing']);
  });
});
