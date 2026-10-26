import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse } from '../messages.js';
import { ALL_LAYERS, hold, holdableLayers, holdReading, holderWord, release, step, type HoldLayer, type HoldReading } from '../hold.js';
import { callOwner } from '../call-origin.js';
import { getProxy } from '../proxy/registry.js';
import { sessions } from '../bench-mode/session.js';
import { readGroup, seekAnimations } from '../bench-mode/animations.js';
import { pageTimeOf } from '../page-time.js';
import { FRAME_MS, frameStep } from '../bench-mode/page-hold.js';
import { applyMotionRules, changeMotionRules, type MotionRule } from '../bench-mode/motion-rules.js';

/** A rule as one line: what it matches, then what it does. */
function describeRule(rule: MotionRule): string {
  const target = [rule.animation ?? 'any animation', rule.element ? `on ${rule.element}` : ''].filter(Boolean).join(' ');
  const acts = [
    rule.off ? 'off, jumps to its end' : '',
    rule.alone ? 'plays alone' : '',
    rule.freezeAt !== undefined ? `held at ${rule.freezeAt}ms` : '',
    rule.duration !== undefined ? `duration ${rule.duration}ms` : '',
    rule.delay !== undefined ? `delay ${rule.delay}ms` : '',
  ].filter(Boolean);
  return `${target}: ${acts.join(', ')}`;
}

const layerEnum = z.enum(['code', 'ui', 'network']);

const holdSchema = z.object({
  action: z.enum(['hold', 'step', 'release', 'status', 'seek', 'rate', 'motion', 'group', 'frame']),
  connection: z.string().describe('Connection name'),
  layers: z.array(layerEnum).optional().describe('hold/release: default all; ui includes code'),
  layer: layerEnum.optional().describe('step: code, ui or network'),
  ms: z.number().optional().describe('seek: ms to move CSS animations; frame: frame length (default 16.7)'),
  playbackRate: z.number().nonnegative().optional().describe('rate: 1 real time, 0.2 a fifth'),
  animation: z.string().optional().describe('motion: animation name or transition property'),
  element: z.string().optional().describe('motion: selector the element matches, e.g. #panel, div.item:nth-child(4)'),
  off: z.boolean().optional().describe('motion: jump to its end when created'),
  alone: z.boolean().optional().describe('motion: pause the other animations'),
  freezeAt: z.number().nonnegative().optional().describe('motion: hold it this many ms in'),
  duration: z.number().nonnegative().optional().describe('motion: its duration ms'),
  delay: z.number().nonnegative().optional().describe('motion: its delay ms'),
  clear: z.boolean().optional().describe('motion: remove matching rules, all if none named'),
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
        const by = layer.via ? `with the ${LAYER_WORDS[layer.via]}` : `by the ${layer.owners.map(holderWord).join(' and ')}`;
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
      'Stop the app across its layers and step it. Layers: code (JS paused), ui (page time, CSS, media, input; JS runs; needs the bench), network (proxy).',
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
            return respond(await hold(connection, { owner: callOwner(), layers: args.layers ?? ALL_LAYERS }));
          case 'release': {
            const before = holdReading(connection).held.map(layer => layer.layer);
            const reading = await release(connection, { by: { kind: 'agent' }, ...(args.layers ? { layers: args.layers } : {}) });
            const after = new Set(reading.held.map(layer => layer.layer));
            const released = before.filter(layer => !after.has(layer));
            // A person's hand hold outlives an agent's release: named so the
            // agent waits on the person rather than releasing again.
            const byHand = reading.held.filter(layer => (!args.layers || args.layers.includes(layer.layer)) && layer.owners.some(owner => owner.kind === 'person'));
            const response = respond(reading);
            const head = released.length ? `Released ${released.map(layer => `${LAYER_WORDS[layer]} (${layer})`).join(', ')}.`
              : byHand.length ? 'Released nothing.' : 'Released nothing: no named layer was held.';
            const kept = byHand.length ? `\nA person holds the ${byHand.map(layer => LAYER_WORDS[layer.layer]).join(' and ')} by hand; it runs again when they release it in the bench.` : '';
            response.content[0].text = `${head}${kept}\n${response.content[0].text}`;
            return { ...response, _meta: { ...response._meta, released, ...(byHand.length ? { heldByPerson: byHand.map(layer => layer.layer) } : {}) } };
          }
          case 'status':
            return respond(holdReading(connection));
          case 'seek': {
            if (typeof args.ms !== 'number') return createErrorResponse('INVALID_PARAMS', { message: 'seek needs ms: how far the running animations move on' });
            const session = sessions.get(connection);
            if (!session) return createErrorResponse('INVALID_PARAMS', { message: `No bench on "${connection}": animations are tracked from bench start` });
            const moved = await seekAnimations(session, args.ms);
            const reading = holdReading(connection);
            const lines = moved.length === 0
              ? [`Seek: no animation running on "${connection}" since the bench opened.`]
              : [`Seek +${args.ms}ms (${reading.held.some(layer => layer.layer === 'ui') ? 'held' : 'running'}):`,
                ...moved.map(a => `  ${a.name} ${Math.round(a.fromMs)}→${Math.round(a.toMs)}/${Math.round(a.durationMs)}ms ${Math.round(a.progress * 100)}%`)];
            return { content: [{ type: 'text', text: lines.join('\n') }], _meta: { ...meta(reading), seek: { ms: args.ms, animations: moved } } };
          }
          case 'frame': {
            const session = sessions.get(connection);
            if (!session) return createErrorResponse('INVALID_PARAMS', { message: `No bench on "${connection}"` });
            if (!session.frozen) return createErrorResponse('INVALID_PARAMS', { message: `Screen of "${connection}" not held: hold ui, or input with holdBeforeFrame` });
            const ms = typeof args.ms === 'number' && args.ms > 0 ? args.ms : FRAME_MS;
            const stepped = await frameStep(session, ms);
            const span = Math.round(ms * 10) / 10;
            const lines = stepped
              ? [`Frame +${span}ms: page ${Math.round(stepped.now)}ms, ${stepped.ran} callback${stepped.ran === 1 ? '' : 's'} ran, ${stepped.waiting} waiting`]
              : [`Frame +${span}ms: CSS only, no page clock (page opened before devharness attached)`];
            return { content: [{ type: 'text', text: lines.join('\n') }], _meta: { ...meta(holdReading(connection)), frame: stepped ?? null } };
          }
          case 'group': {
            const session = sessions.get(connection);
            if (!session) return createErrorResponse('INVALID_PARAMS', { message: `No bench on "${connection}"` });
            const group = await readGroup(session);
            const lines = group.length === 0
              ? [`No group: no animation created since a frame stop on "${connection}".`]
              : [`${group.length} animation${group.length === 1 ? '' : 's'} since the frame stop (at/duration, delay, easing):`,
                ...group.map(a => `  ${a.element ?? '?'} ${a.name} ${Math.round(a.currentMs)}/${Math.round(a.durationMs)}ms${a.delayMs ? ` +${Math.round(a.delayMs)}` : ''} ${a.easing}`)];
            return { content: [{ type: 'text', text: lines.join('\n') }], _meta: { ...meta(holdReading(connection)), group } };
          }
          case 'rate': {
            if (typeof args.playbackRate !== 'number') return createErrorResponse('INVALID_PARAMS', { message: 'rate needs playbackRate: 1 is real time, 0.2 a fifth of it' });
            const time = sessions.get(connection)?.time ?? pageTimeOf(connection);
            if (!time) return createErrorResponse('INVALID_PARAMS', { message: `No page time on "${connection}": it needs a debugger connection or a bench` });
            await time.setRate(args.playbackRate);
            return {
              content: [{ type: 'text', text: `Rate ${args.playbackRate}× for CSS and page clock, ${time.stopped ? 'on release' : 'from now'}` }],
              _meta: { ...meta(holdReading(connection)), playbackRate: args.playbackRate },
            };
          }
          case 'motion': {
            const session = sessions.get(connection);
            if (!session) return createErrorResponse('INVALID_PARAMS', { message: `No bench on "${connection}"` });
            const target = {
              ...(args.animation ? { animation: args.animation } : {}),
              ...(args.element ? { element: args.element } : {}),
            };
            const acts = {
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
            // A rule set while a frame stop holds its group acts on the group now,
            // where it would otherwise meet only the animations started after it.
            const group = Object.keys(acts).length && !args.clear && session.frozen ? await readGroup(session) : [];
            for (const one of group) {
              const applied = await applyMotionRules(session, one.id, true);
              if (applied) session.motionApplied = [...(session.motionApplied ?? []), applied].slice(-50);
            }
            const applied = (session.motionApplied ?? []).slice(-5);
            const lines = [
              rules.length ? `${rules.length} rule${rules.length === 1 ? '' : 's'}${group.length ? `, applied to the ${group.length} held` : ''}:` : 'No rules.',
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
