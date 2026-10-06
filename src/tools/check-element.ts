/**
 * The element a check, assert or wait reads, against the one it was recorded
 * on. Read by selector alone, a check that now resolves to another element
 * answers about the wrong one; compared first, as a click is, it is refused
 * with the repair a click's refusal carries.
 */
import { createErrorResponse } from '../messages.js';
import { readFingerprint, refuseOtherElement, type ElementFingerprint } from '../element-fingerprint.js';
import type { ToolResponseMeta } from '../tool-response.js';

/** The element `selector` resolves to now, and the refusal where it is not the one `expect` names. */
export async function guardElement(
  args: { selector?: string; connection?: string; expect?: Record<string, unknown> },
  resolveConnection: (connection: string) => Promise<any>,
): Promise<{ fingerprint?: ElementFingerprint; refused?: any }> {
  if (!args.selector || !args.connection) return {};
  const page = (await resolveConnection(args.connection).catch(() => null))?.puppeteerManager?.getPage?.();
  if (!page) return {};
  const fingerprint = await readFingerprint(page, { selector: args.selector });
  const refused = await refuseOtherElement(page, args.expect as ElementFingerprint | undefined, fingerprint);
  if (!refused) return fingerprint ? { fingerprint } : {};
  return {
    refused: {
      ...createErrorResponse('INPUT_ELEMENT_MISMATCH', { action: 'check', target: args.selector, line: refused.line }),
      _meta: {
        tool: 'check', action: 'element', timestamp: Date.now(),
        element: { ...(fingerprint ? { fingerprint } : {}), repair: refused.repair },
      } satisfies ToolResponseMeta,
    },
  };
}
