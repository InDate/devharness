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

const proxySchema = z.object({
  action: z.enum(['status', 'events', 'body', 'hold', 'holdFrame', 'release', 'holds'])
    .describe('status (is a proxy running for this browser), events (what crossed the boundary, newest last), body (one event\'s kept payload), hold (answer a URL with a value instead of reaching the server), holdFrame (replace or drop a socket message), release (remove a hold), holds (what is held)'),
  connectionReason: z.string()
    .describe('The browser, as named at launchChrome({ proxy: true })'),
  since: z.number().optional().describe('events: epoch ms, at or after'),
  until: z.number().optional().describe('events: epoch ms, before'),
  id: z.string().optional().describe('body: the event id. release: the hold id'),
  urlIncludes: z.string().optional().describe('events: only what crossed to a URL containing this - Chrome talks to Google constantly through the same proxy and those are not the app. hold/holdFrame: substring of the URL the hold applies to'),
  method: z.string().optional().describe('hold: only this HTTP method'),
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
            return {
              content: [{ type: 'text', text:
                `Proxy running for "${args.connectionReason}". ${events.length} event(s) seen, `
                + `${proxy.listPins().length} response hold(s), ${proxy.listFramePins().length} message hold(s).` }],
              _meta: meta({ proxy: { events: events.length } }),
            };
          }

          case 'events': {
            const all = proxy.eventsIn(args.since, args.until);
            const events = args.urlIncludes
              ? all.filter(e => e.url.includes(args.urlIncludes!))
              : all;
            const elsewhere = all.length - events.length;
            const lines = events.map(e => e.kind === 'request'
              ? `${e.id}  ${e.method} ${e.url} ${e.status ?? 'pending'}${e.heldAs ? ` [${e.heldAs}]` : ''}`
              : `${e.id}  ${e.direction === 'out' ? '->' : '<-'} ${e.url} ${e.size}b${e.heldAs ? ` [${e.heldAs}]` : ''}`);
            return {
              content: [{ type: 'text', text: events.length === 0
                ? `Nothing matching crossed the boundary in that window.${elsewhere ? ` ${elsewhere} went elsewhere.` : ''}`
                : `${events.length} event(s)${elsewhere ? `, ${elsewhere} elsewhere` : ''}\n\n${lines.join('\n')}` }],
              _meta: meta({ proxyEvents: events, elsewhere }),
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
              ...(args.status !== undefined ? { status: args.status } : {}),
              ...(args.contentType ? { headers: { 'content-type': args.contentType } } : {}),
              body: args.value ?? '',
            });
            return {
              content: [{ type: 'text', text: `Holding ${pin.method ?? 'any'} *${pin.urlIncludes}* as ${pin.id}.` }],
              _meta: meta({ proxy: { pin } }),
            };
          }

          case 'holdFrame': {
            const pin = proxy.pinFrame({
              textIncludes: args.textIncludes ?? '',
              ...(args.urlIncludes ? { urlIncludes: args.urlIncludes } : {}),
              ...(args.direction ? { direction: args.direction } : {}),
              ...(args.value !== undefined ? { replaceWith: args.value } : {}),
            });
            return {
              content: [{ type: 'text', text:
                `${pin.replaceWith === undefined ? 'Dropping' : 'Replacing'} messages containing "${pin.textIncludes}" as ${pin.id}.` }],
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
              ...pins.map(p => `${p.id}  ${p.method ?? 'any'} *${p.urlIncludes}* -> ${p.status}, ${p.hits} hit(s)`),
              ...frames.map(p => `${p.id}  message *${p.textIncludes}* -> ${p.replaceWith === undefined ? 'dropped' : 'replaced'}, ${p.hits} hit(s)`),
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
