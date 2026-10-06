/**
 * The most text one tool reply returns to the caller.
 *
 * A reply that lists a buffer - requests, console lines, page text, an
 * evaluated value, a DOM snapshot - could return all of it, and a single call
 * then filled a caller's context. Text past the bound is cut here, where
 * every reply leaves, with the length cut and how to narrow the call. History
 * keeps the whole reply, so `replay history` and a repeat still read it.
 */
export const REPLY_TEXT_CHARS = 40_000;

export function boundReply<T extends { content?: Array<{ type: string; text?: string }> }>(reply: T, limit = REPLY_TEXT_CHARS): T {
  const parts = reply?.content;
  if (!Array.isArray(parts)) return reply;
  const total = parts.reduce((sum, part) => sum + (part.type === 'text' ? part.text?.length ?? 0 : 0), 0);
  if (total <= limit) return reply;
  let left = limit;
  const kept = parts.map(part => {
    if (part.type !== 'text' || part.text === undefined) return part;
    const text = part.text.slice(0, Math.max(0, left));
    left -= text.length;
    return { ...part, text };
  }).filter(part => part.type !== 'text' || (part.text ?? '').length > 0);
  kept.push({
    type: 'text',
    text: `\n\n[Reply cut at ${limit} of ${total} characters. Narrow the call to read the rest: a filter, a limit, a selector, a since, or a smaller expression.]`,
  });
  return { ...reply, content: kept };
}
