import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse } from '../messages.js';
import { createGroup, endGroup, hasGroup, listGroups, membersOf } from '../groups.js';
import type { ConnectionManager } from '../connection-manager.js';

const groupSchema = z.object({
  action: z.enum(['create', 'list', 'close']),
  group: z.string().min(1).optional().describe('create/close: the group; list: one group (default: all)'),
  reason: z.string().optional().describe('close: why its browsers are closed'),
}).strict();

export function createGroupTools(connectionManager: ConnectionManager) {
  /** Each member with whether a live connection stands under its name. */
  const rows = (name: string) => membersOf(name).map(member => ({
    connection: member,
    open: !!connectionManager.findConnectionByReference(member),
  }));

  return {
    group: createTool(
      'Named sets of browsers. Launch into one with connection launch `group`.',
      groupSchema,
      async (args) => {
        const meta = (extra: Record<string, unknown>) => ({ tool: 'group', action: args.action, timestamp: Date.now(), ...extra });
        switch (args.action) {
          case 'create': {
            if (!args.group) return createErrorResponse('INVALID_PARAMS', { message: 'create needs group: its name' });
            const created = createGroup(args.group);
            return {
              content: [{ type: 'text', text: created
                ? `Group "${args.group}" created, with no browsers. \`connection launch\` with group: "${args.group}" adds one.`
                : `Group "${args.group}" already exists, with ${membersOf(args.group).length} browser(s).` }],
              _meta: meta({ group: { name: args.group, created, members: rows(args.group) } }),
            };
          }
          case 'list': {
            if (args.group && !hasGroup(args.group)) {
              return createErrorResponse('INVALID_PARAMS', { message: `No group "${args.group}". \`group({ action: 'list' })\` names every group.` });
            }
            const groups = (args.group ? [args.group] : listGroups().map(g => g.name)).map(name => ({ name, members: rows(name) }));
            const lines = groups.length === 0
              ? ['No groups.']
              : groups.flatMap(g => [
                `${g.name}: ${g.members.length} browser(s)`,
                ...g.members.map(m => `  ${m.connection}${m.open ? '' : ' (closed)'}`),
              ]);
            return { content: [{ type: 'text', text: lines.join('\n') }], _meta: meta({ groups }) };
          }
          case 'close': {
            if (!args.group) return createErrorResponse('INVALID_PARAMS', { message: 'close needs group: the group whose browsers close' });
            if (!hasGroup(args.group)) {
              return createErrorResponse('INVALID_PARAMS', { message: `No group "${args.group}". \`group({ action: 'list' })\` names every group.` });
            }
            console.error(`[devharness] group close - Reason: ${args.reason}, Group: ${args.group}`);
            const closed: string[] = [];
            const failed: string[] = [];
            for (const member of endGroup(args.group)) {
              const connection = connectionManager.findConnectionByReference(member);
              if (!connection) continue;
              if (await connectionManager.closeConnection(connection.id)) closed.push(member);
              else failed.push(member);
            }
            const lines = [
              `Group "${args.group}" ended; ${closed.length} browser(s) closed${closed.length ? `: ${closed.join(', ')}` : ''}.`,
              ...(failed.length ? [`Not closed: ${failed.join(', ')}.`] : []),
            ];
            return { content: [{ type: 'text', text: lines.join('\n') }], _meta: meta({ group: { name: args.group, closed, failed } }), ...(failed.length ? { isError: true } : {}) };
          }
        }
      },
    ),
  };
}
