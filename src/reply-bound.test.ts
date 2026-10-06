/**
 * One bound on the text a tool reply returns, with how much was cut.
 */
import { describe, it, expect } from 'vitest';
import { boundReply } from './reply-bound.js';

describe('a tool reply over the bound', () => {
  it('keeps the first characters across its parts and names the length cut', () => {
    const reply = boundReply({ content: [{ type: 'text', text: 'a'.repeat(30) }, { type: 'text', text: 'b'.repeat(30) }] }, 40);
    expect(reply.content![0].text).toBe('a'.repeat(30));
    expect(reply.content![1].text).toBe('b'.repeat(10));
    expect(reply.content![2].text).toContain('Reply cut at 40 of 60 characters');
  });

  it('returns a reply within the bound as it is', () => {
    const within = { content: [{ type: 'text', text: 'short' }], _meta: { tool: 'x' } };
    expect(boundReply(within, 40)).toBe(within);
  });
});
