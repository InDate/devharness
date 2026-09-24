/**
 * Reading and steering the intercepting proxy a browser was launched through.
 *
 * What the proxy holds is what reached the outside world. Local reads and
 * writes - cache, storage - never appear here, which is the point: this answers
 * "what did the app do externally", and CDP answers the rest.
 */
import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse } from '../messages.js';
import { getProxy, listProxies } from '../proxy/registry.js';
import { levelOf, type ProxyEvent, type ProxyCursor } from '../proxy/intercept-proxy.js';

/** A cursor as one column: the command, or the replay pass and step. */
function cursorText(cursor: ProxyCursor | undefined): string {
  if (!cursor) return '';
  if (cursor.kind === 'command') return `cmd ${cursor.index}`;
  if (cursor.kind === 'replay') return `${cursor.runId}/${cursor.step}`;
  return 'idle';
}

/**
 * What one event shows: the level the policy reads, and the cursor that level
 * points at. A paired arrival points at the send it settles; everything else
 * points at where it crossed, which names when and not why.
 */
function stampOf(e: ProxyEvent): string {
  const level = levelOf(e);
  const sent = e.evidence?.pairing?.sentUnder;
  const where = sent && (level === 'observed' || level === 'likely')
    ? cursorText(sent)
    : cursorText(e.runId !== undefined
        ? { kind: 'replay', runId: e.runId, step: e.step ?? 0 }
        : e.commandIndex !== undefined
          ? { kind: 'command', index: e.commandIndex }
          : undefined);
  return `${where ? `${where}  ` : ''}`;
}

const proxySchema = z.object({
  action: z.enum(['status', 'events', 'sockets', 'body', 'hold', 'holdFrame', 'release', 'holds', 'refuse'])
    .describe('status (is a proxy running for this browser), events (what crossed the boundary, newest last), sockets (what each socket did, and whether arrival names a cause on it), body (one event\'s kept payload), hold (answer a URL with a value instead of reaching the server), holdFrame (replace or drop a socket message), release (remove a hold), holds (what is held), refuse (answer every unmatched write with 403, or forward it)'),
  connectionReason: z.string()
    .describe('The browser, as named at launchChrome({ proxy: true })'),
  since: z.number().optional().describe('events: epoch ms, at or after'),
  until: z.number().optional().describe('events: epoch ms, before'),
  id: z.string().optional().describe('body: the event id. release: the hold id'),
  urlIncludes: z.string().optional().describe('events: only what crossed to a URL containing this - Chrome talks to Google constantly through the same proxy and those are not the app. hold/holdFrame: substring of the URL the hold applies to'),
  method: z.string().optional().describe('hold: only this HTTP method'),
  step: z.coerce.number().int().min(0).optional().describe('hold/holdFrame: only while this replay step (0-based) is in flight, so the hold answers at one position in a run and the same call at another position reaches the server'),
  unmatchedWrites: z.enum(['refuse', 'forward']).optional().describe('refuse: what an unmatched POST/PUT/PATCH/DELETE meets - refuse answers it 403 and records it as refused; forward is the default'),
  status: z.number().optional().describe('hold: status to answer with (default 200)'),
  contentType: z.string().optional().describe('hold: content-type to answer with (default application/json)'),
  value: z.string().optional().describe('hold: the body to answer with. holdFrame: what to send in the message\'s place - omit to drop it so nothing arrives'),
  textIncludes: z.string().optional().describe('holdFrame: substring of the message payload that selects it'),
  direction: z.enum(['sent', 'received']).optional().describe('holdFrame: only messages going this way'),
}).strict();

export function createProxyTools() {
  return {
    proxy: createTool(
      'Read and steer the intercepting proxy a browser was launched through: what crossed the boundary, and what to answer with instead.',
      proxySchema,
      async (args) => {
        const proxy = getProxy(args.connectionReason);
        if (!proxy) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: `No proxy for "${args.connectionReason}". Launch with launchChrome({ proxy: true }). Running: ${listProxies().join(', ') || 'none'}`,
          });
        }

        const meta = (extra: Record<string, unknown>) => ({
          tool: 'proxy', action: args.action, timestamp: Date.now(), ...extra,
        });

        switch (args.action) {
          case 'status': {
            const events = proxy.eventsIn();
            const allowed = proxy.listAllowedHosts();
            const refusals = proxy.refusals();
            const lines = [
              `Proxy running for "${args.connectionReason}". ${events.length} event(s) seen.`,
              allowed.length
                ? `Only these reach the network: ${allowed.join(', ')}. Everything else is refused.`
                : 'The browser\'s own service hosts are refused; everything else reaches the network.',
              `${proxy.blocked} call(s) refused${refusals.length ? ':' : '.'}`,
              ...refusals.slice(0, 10).map(r => `  ${r.count.toString().padStart(4)}  ${r.host}`),
              ...(refusals.length > 10 ? [`  … and ${refusals.length - 10} more host(s)`] : []),
              proxy.refusesWrites
                ? `Unmatched writes are refused: ${proxy.refusedWrites} answered 403.`
                : 'Unmatched writes are forwarded to the server.',
              `${proxy.listPins().length} response hold(s), ${proxy.listFramePins().length} message hold(s).`,
            ];
            return {
              content: [{ type: 'text', text: lines.join('\n') }],
              _meta: meta({ proxy: {
                events: events.length, blocked: proxy.blocked, allowed, refusals,
                refusesWrites: proxy.refusesWrites, refusedWrites: proxy.refusedWrites,
              } }),
            };
          }

          case 'refuse': {
            proxy.refuseUnmatchedWrites(args.unmatchedWrites === 'refuse');
            return {
              content: [{ type: 'text', text: proxy.refusesWrites
                ? 'Every unmatched POST, PUT, PATCH or DELETE is now answered 403 and recorded as refused. Reads still reach the server.'
                : 'Unmatched writes are forwarded to the server.' }],
              _meta: meta({ proxy: { refusesWrites: proxy.refusesWrites } }),
            };
          }

          case 'events': {
            const all = proxy.eventsIn(args.since, args.until);
            const events = args.urlIncludes
              ? all.filter(e => e.url.includes(args.urlIncludes!))
              : all;
            const elsewhere = all.length - events.length;
            const lines = events.map(e => {
              const cmd = stampOf(e);
              // The level sits beside the stamp: a stamp with no statement of
              // what backs it reads as attribution whatever it was built from.
              const sure = ` (${levelOf(e)})`;
              return e.kind === 'request'
                ? `${e.id}  ${cmd}${e.method} ${e.url} ${e.status ?? 'pending'}${sure}${e.evidence?.initiator ? ` <${e.evidence.initiator}>` : ''}${e.heldAs ? ` [${e.heldAs}]` : ''}`
                : `${e.id}  ${cmd}${e.direction === 'out' ? '->' : '<-'} ${e.url} ${e.size}b${sure}${e.evidence?.initiator ? ` <${e.evidence.initiator}>` : ''}${e.heldAs ? ` [${e.heldAs}]` : ''}`;
            });
            return {
              content: [{ type: 'text', text: events.length === 0
                ? `Nothing matching crossed the boundary in that window.${elsewhere ? ` ${elsewhere} went elsewhere.` : ''}`
                : `${events.length} event(s)${elsewhere ? `, ${elsewhere} elsewhere` : ''}\n\n${lines.join('\n')}` }],
              _meta: meta({ proxyEvents: events, elsewhere }),
            };
          }

          case 'sockets': {
            const shapes = proxy.socketShapes();
            const lines = shapes.map(p =>
              `${p.shape.padEnd(10)} ${p.url}  sent ${p.sent}, received ${p.received}` +
              `${p.paired ? `, ${p.paired} paired by id` : ''}` +
              `${p.receivedUnprompted ? `, ${p.receivedUnprompted} unprompted` : ''}` +
              `${p.receivedLate ? `, ${p.receivedLate} late` : ''}` +
              `${p.allowancesRefused ? `, ${p.allowancesRefused} sends unaccounted` : ''}` +
              `${p.sentUnprompted ? `, ${p.sentUnprompted} sends on a timer` : ''}` +
              `${p.longestRun > 1 ? `, longest run ${p.longestRun}` : ''}`);
            return {
              content: [{ type: 'text', text: shapes.length === 0
                ? 'No socket crossed this proxy.'
                : `${shapes.length} socket(s)\n\n${lines.join('\n')}\n\n` +
                  'reply: every arrival was accounted to an outstanding send. ' +
                  'push: something arrived with no send outstanding, so the socket speaks on its own.' }],
              _meta: meta({ sockets: shapes }),
            };
          }

          case 'body': {
            const body = args.id ? proxy.bodyOf(args.id) : undefined;
            return {
              content: [{ type: 'text', text: body ?? `No kept payload for "${args.id}".` }],
              _meta: meta({ proxy: { id: args.id, bytes: body?.length ?? 0 } }),
            };
          }

          case 'hold': {
            const pin = proxy.pin({
              urlIncludes: args.urlIncludes ?? '',
              ...(args.method ? { method: args.method } : {}),
              ...(args.step !== undefined ? { step: args.step } : {}),
              ...(args.status !== undefined ? { status: args.status } : {}),
              ...(args.contentType ? { headers: { 'content-type': args.contentType } } : {}),
              body: args.value ?? '',
            });
            return {
              content: [{ type: 'text', text: `Holding ${pin.method ?? 'any'} *${pin.urlIncludes}*${pin.step !== undefined ? ` under step ${pin.step}` : ''} as ${pin.id}.` }],
              _meta: meta({ proxy: { pin } }),
            };
          }

          case 'holdFrame': {
            const pin = proxy.pinFrame({
              textIncludes: args.textIncludes ?? '',
              ...(args.urlIncludes ? { urlIncludes: args.urlIncludes } : {}),
              ...(args.direction ? { direction: args.direction } : {}),
              ...(args.step !== undefined ? { step: args.step } : {}),
              ...(args.value !== undefined ? { replaceWith: args.value } : {}),
            });
            return {
              content: [{ type: 'text', text:
                `${pin.replaceWith === undefined ? 'Dropping' : 'Replacing'} messages ${pin.field ? `whose field ${pin.field.key} is ${JSON.stringify(pin.field.value)}` : `containing "${pin.textIncludes}"`}${pin.step !== undefined ? ` under step ${pin.step}` : ''} as ${pin.id}.` }],
              _meta: meta({ proxy: { pin } }),
            };
          }

          case 'release': {
            const gone = args.id ? proxy.unpin(args.id) : false;
            return {
              content: [{ type: 'text', text: gone ? `Released ${args.id}.` : `No hold called "${args.id}".` }],
              _meta: meta({ proxy: { released: gone } }),
            };
          }

          case 'holds': {
            const pins = proxy.listPins();
            const frames = proxy.listFramePins();
            const lines = [
              ...pins.map(p => `${p.id}  ${p.method ?? 'any'} *${p.urlIncludes}*${p.step !== undefined ? ` step ${p.step}` : ''} -> ${p.status}, ${p.hits} hit(s)`),
              ...frames.map(p => `${p.id}  message ${p.field ? `field ${p.field.key} = ${JSON.stringify(p.field.value)}` : `text *${p.textIncludes}*`}${p.step !== undefined ? ` step ${p.step}` : ''} -> ${p.replaceWith === undefined ? 'dropped' : 'replaced'}, ${p.hits} hit(s)`),
            ];
            return {
              content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'Nothing held.' }],
              _meta: meta({ proxy: { pins, framePins: frames } }),
            };
          }
        }
      }
    ),
  };
}
