import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse } from '../messages.js';
import { ALL_LAYERS, hold, holdableLayers, holdReading, release, step, type HoldLayer, type HoldReading } from '../hold.js';
import { getProxy } from '../proxy/registry.js';
import { sessions } from '../bench-mode/session.js';
import { readGroup, seekAnimations, setPlaybackRate } from '../bench-mode/animations.js';
import { changeMotionRules, type MotionRule } from '../bench-mode/motion-rules.js';

/** A rule as one line: what it matches, then what it does. */
function describeRule(rule: MotionRule): string {
  const target = [rule.animation ?? 'any animation', rule.element ? `on ${rule.element}` : ''].filter(Boolean).join(' ');
  const acts = [
    rule.off ? 'off, jumps to its end' : '',
    rule.slow !== undefined ? `speed ${rule.slow}×` : '',
    rule.alone ? 'plays alone' : '',
    rule.freezeAt !== undefined ? `held at ${rule.freezeAt}ms` : '',
    rule.duration !== undefined ? `duration ${rule.duration}ms` : '',
    rule.delay !== undefined ? `delay ${rule.delay}ms` : '',
  ].filter(Boolean);
  return `${target}: ${acts.join(', ')}`;
}

const layerEnum = z.enum(['code', 'ui', 'network']);

const holdSchema = z.object({
  action: z.enum(['hold', 'step', 'release', 'status', 'seek', 'rate', 'motion', 'group']),
  connection: z.string().describe('The connection, by the name connection launch gave it'),
  layers: z.array(layerEnum).optional()
    .describe('hold/release: which layers; all of them by default. ui carries code with it'),
  layer: layerEnum.optional()
    .describe('step: code moves one statement, ui one callback, network one message'),
  ms: z.number().optional()
    .describe('seek: move every running CSS transition, CSS animation and web animation on by this much of its own time, JS untouched; needs the bench open'),
  playbackRate: z.number().nonnegative().optional()
    .describe('rate: what the page\'s animations run at while released, 1 real time, 0.2 a fifth; a release restores it'),
  animation: z.string().optional().describe('motion: the animation a rule acts on, by its name or transition property; any when absent'),
  element: z.string().optional().describe('motion: the animated element as the ACTION rows name it, #id or tag.class; any when absent'),
  slow: z.number().positive().optional().describe('motion: run the matched animation at this multiple of real time, below 1 slower, above 1 faster'),
  off: z.boolean().optional().describe('motion: jump the matched animation to its end as it starts'),
  alone: z.boolean().optional().describe('motion: pause every other animation while the rule stands'),
  freezeAt: z.number().nonnegative().optional().describe('motion: hold the matched animation this many ms in, the rest running'),
  duration: z.number().nonnegative().optional().describe('motion: the matched animation\'s duration in ms, in place of the page\'s'),
  delay: z.number().nonnegative().optional().describe('motion: its delay in ms, in place of the page\'s'),
  clear: z.boolean().optional().describe('motion: remove the rule for this animation and element, or every rule with neither named'),
}).strict();

export const LAYER_WORDS = { code: 'code', ui: 'screen', network: 'traffic' } as const;

/** Why each layer with no mechanism attached stayed running. */
export function unavailableNote(layers: readonly HoldLayer[]): string {
  return `nothing attached to hold ${layers.join(', ')}`
    + (layers.includes('network') ? ' - traffic holds only for a browser launched with proxy: true' : '')
    + (layers.includes('ui') ? ' - the screen holds only with the bench open' : '');
}

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
    lines.push(`Not held, ${unavailableNote(reading.unavailable)}`);
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
      'Stop the driven app at one moment across its layers - code, screen, traffic - step it, and let it run. Actions: hold (stop the layers), step (move one held layer on by its unit), release (let the layers run), status (what is held, where each stands, what waits at the proxy), seek (move the running animations on by ms, held or not), rate (the playback rate of the animations while released), motion (rules on single animations as they start: slow, off, alone, freezeAt, timing; none given lists them)',
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

        if (holdableLayers(connection).length === 0 && holdReading(connection).held.length === 0) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: `Nothing on "${connection}" can be held: no connection by that name has a debugger, a bench or a proxy attached. \`connection({ action: 'list' })\` names the live ones.`,
          });
        }
        switch (args.action) {
          case 'hold':
            return respond(await hold(connection, { source: 'tool', layers: args.layers ?? ALL_LAYERS }));
          case 'release': {
            const before = holdReading(connection).held.map(layer => layer.layer);
            const reading = await release(connection, args.layers ? { layers: args.layers } : {});
            const after = new Set(reading.held.map(layer => layer.layer));
            const released = before.filter(layer => !after.has(layer));
            const response = respond(reading);
            response.content[0].text = `${released.length ? `Released ${released.map(layer => `${LAYER_WORDS[layer]} (${layer})`).join(', ')}.` : 'Released nothing: no named layer was held.'}\n${response.content[0].text}`;
            return { ...response, _meta: { ...response._meta, released } };
          }
          case 'status':
            return respond(holdReading(connection));
          case 'seek': {
            if (typeof args.ms !== 'number') return createErrorResponse('INVALID_PARAMS', { message: 'seek needs ms: how far the running animations move on' });
            const session = sessions.get(connection);
            if (!session) return createErrorResponse('INVALID_PARAMS', { message: `No bench is open on "${connection}": the animations are tracked from \`bench({ action: 'start' })\` on, so an animation started before it is not seen` });
            const moved = await seekAnimations(session, args.ms);
            const reading = holdReading(connection);
            const lines = moved.length === 0
              ? [`No animation is running on "${connection}" that the bench has seen start; a seek moves CSS transitions, CSS animations and web animations started since the bench opened.`]
              : [`Moved ${moved.length} animation${moved.length === 1 ? '' : 's'} on by ${args.ms}ms${reading.held.some(layer => layer.layer === 'ui') ? ', the screen still held' : ', the screen running'}:`,
                ...moved.map(a => `  ${a.type} ${a.name}: ${Math.round(a.fromMs)}ms → ${Math.round(a.toMs)}ms of ${Math.round(a.durationMs)}ms (${Math.round(a.progress * 100)}%)`)];
            return { content: [{ type: 'text', text: lines.join('\n') }], _meta: { ...meta(reading), seek: { ms: args.ms, animations: moved } } };
          }
          case 'group': {
            const session = sessions.get(connection);
            if (!session) return createErrorResponse('INVALID_PARAMS', { message: `No bench is open on "${connection}": a group is the animations an input started at a frame stop, taken by \`input\` with \`hold: ['ui']\` and \`holdBeforeFrame: true\`` });
            const group = await readGroup(session);
            const lines = group.length === 0
              ? [`No group on "${connection}": no animation was created since the last frame stop, or none was armed.`]
              : [`${group.length} animation${group.length === 1 ? '' : 's'} started by the input at the frame stop:`,
                ...group.map(a => `  ${a.element ?? '?'} ${a.name}: ${Math.round(a.currentMs)}ms of ${a.delayMs ? `${Math.round(a.delayMs)}ms delay + ` : ''}${Math.round(a.durationMs)}ms, ${a.easing}`)];
            return { content: [{ type: 'text', text: lines.join('\n') }], _meta: { ...meta(holdReading(connection)), group } };
          }
          case 'rate': {
            if (typeof args.playbackRate !== 'number') return createErrorResponse('INVALID_PARAMS', { message: 'rate needs playbackRate: 1 is real time, 0.2 a fifth of it' });
            const session = sessions.get(connection);
            if (!session) return createErrorResponse('INVALID_PARAMS', { message: `No bench is open on "${connection}": the playback rate is set through its session` });
            await setPlaybackRate(session, args.playbackRate);
            const reading = holdReading(connection);
            const held = reading.held.some(layer => layer.layer === 'ui');
            return {
              content: [{ type: 'text', text: `Animations on "${connection}" run at ${args.playbackRate}× ${held ? 'once the screen is released' : 'from now'}; a hold still stops them, and a release puts this rate back.` }],
              _meta: { ...meta(reading), playbackRate: args.playbackRate },
            };
          }
          case 'motion': {
            const session = sessions.get(connection);
            if (!session) return createErrorResponse('INVALID_PARAMS', { message: `No bench is open on "${connection}": an animation is seen starting through its session` });
            const target = {
              ...(args.animation ? { animation: args.animation } : {}),
              ...(args.element ? { element: args.element } : {}),
            };
            const acts = {
              ...(args.slow !== undefined ? { slow: args.slow } : {}),
              ...(args.off !== undefined ? { off: args.off } : {}),
              ...(args.alone !== undefined ? { alone: args.alone } : {}),
              ...(args.freezeAt !== undefined ? { freezeAt: args.freezeAt } : {}),
              ...(args.duration !== undefined ? { duration: args.duration } : {}),
              ...(args.delay !== undefined ? { delay: args.delay } : {}),
            };
            const rules = args.clear
              ? await changeMotionRules(session, { clear: target })
              : Object.keys(acts).length
                ? await changeMotionRules(session, { rule: { ...target, ...acts } })
                : session.motionRules ?? [];
            const applied = (session.motionApplied ?? []).slice(-10);
            const lines = [
              rules.length ? `${rules.length} motion rule${rules.length === 1 ? '' : 's'} on "${connection}", acting on each matching animation as it starts:` : `No motion rule stands on "${connection}".`,
              ...rules.map(rule => `  ${describeRule(rule)}`),
              ...(applied.length ? ['Last applied:', ...applied.map(one => `  ${one.animation}${one.element ? ` ${one.element}` : ''}: ${one.did.join(', ')}`)] : []),
            ];
            return { content: [{ type: 'text', text: lines.join('\n') }], _meta: { ...meta(holdReading(connection)), motion: { rules, applied } } };
          }
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
