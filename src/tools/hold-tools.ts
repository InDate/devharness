import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse } from '../messages.js';
import { ALL_LAYERS, hold, holdReading, release, step, type HoldReading } from '../hold.js';
import { getProxy } from '../proxy/registry.js';

const layerEnum = z.enum(['code', 'ui', 'network']);

const holdSchema = z.object({
  action: z.enum(['hold', 'step', 'release', 'status']),
  connection: z.string().describe('The connection, by the name connection launch gave it'),
  layers: z.array(layerEnum).optional()
    .describe('hold/release: which layers; all of them by default. ui carries code with it'),
  layer: layerEnum.optional()
    .describe('step: code moves one statement, ui one callback, network one message'),
}).strict();

const LAYER_WORDS = { code: 'code', ui: 'screen', network: 'traffic' } as const;

function render(reading: HoldReading): string {
  const lines = reading.held.length === 0
    ? [`Nothing is held on "${reading.connection}".`]
    : reading.held.map(layer => {
        const where = layer.standing
          ? ' - ' + Object.entries(layer.standing).map(([key, value]) => `${key} ${value}`).join(', ')
          : '';
        const by = layer.via ? `with the ${LAYER_WORDS[layer.via]}` : `by the ${layer.source}`;
        return `${LAYER_WORDS[layer.layer]} (${layer.layer}) held ${by}${where}`;
      });
  if (reading.unavailable.length) {
    lines.push(`Not held, nothing attached to hold it: ${reading.unavailable.join(', ')}`
      + (reading.unavailable.includes('network') ? ' - traffic holds only for a browser launched with proxy: true' : '')
      + (reading.unavailable.includes('ui') ? ' - the screen holds only with the bench open' : ''));
  }
  const queued = getProxy(reading.connection)?.queue.list() ?? [];
  if (queued.length) {
    lines.push(`${queued.length} waiting at the proxy, oldest first:`);
    for (const item of queued.slice(0, 20)) {
      const what = item.kind === 'response' ? 'response' : item.direction ?? 'frame';
      lines.push(`  #${item.id} ${what} ${item.url} waited ${item.ageMs}ms${item.preview ? `  ${item.preview.slice(0, 80)}` : ''}`);
    }
    if (queued.length > 20) lines.push(`  … and ${queued.length - 20} more`);
  }
  return lines.join('\n');
}

export function createHoldTools() {
  return {
    hold: createTool(
      'Stop the driven app at one moment across its layers - code, screen, traffic - step it, and let it run. Actions: hold (stop the layers), step (move one held layer on by its unit), release (let the layers run), status (what is held, where each stands, what waits at the proxy)',
      holdSchema,
      async (args) => {
        const { connection } = args;
        const meta = (reading: HoldReading) => ({
          tool: 'hold', action: args.action, timestamp: Date.now(),
          hold: { ...reading, queued: getProxy(connection)?.queue.list() ?? [] },
        });
        const respond = (reading: HoldReading) => ({
          content: [{ type: 'text', text: render(reading) }],
          _meta: meta(reading),
        });

        switch (args.action) {
          case 'hold':
            return respond(await hold(connection, { source: 'tool', layers: args.layers ?? ALL_LAYERS }));
          case 'release':
            return respond(await release(connection, args.layers ? { layers: args.layers } : {}));
          case 'status':
            return respond(holdReading(connection));
          case 'step': {
            if (!args.layer) {
              return createErrorResponse('INVALID_PARAMS', { message: 'step needs a layer: code, ui or network' });
            }
            try {
              return respond(await step(connection, args.layer));
            } catch (error) {
              return createErrorResponse('INVALID_PARAMS', { message: error instanceof Error ? error.message : String(error) });
            }
          }
        }
      },
    ),
  };
}
