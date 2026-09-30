/**
 * Message tool - text between two devharness sessions on this machine.
 *
 * Transport is `src/session-messages.ts`: one append-only JSONL mailbox per
 * session under `~/.devharness/messages/`. Discovery reuses the dashboard
 * hub's session registry, which already holds every live session's short id,
 * pid and project directory.
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { getProjectDir } from '../helpers/paths.js';
import { getSessionInfo } from './dashboard-tools.js';
import { listSessionRecords } from '../session-endpoint.js';
import { resolveSessionName } from '../session-identity.js';
import { appendEvent, getEventStreamPath } from '../session-events.js';
import type { ToolResponseMeta, MessageToolMeta } from '../tool-response.js';
import {
  isValidMailboxId,
  getMailboxPath,
  getMessagesDir,
  listMailboxIds,
  readMailbox,
  readCursor,
  writeCursor,
  sendMessage,
  waitForMailbox,
  type SessionMessage,
} from '../session-messages.js';

const messageSchema = z.object({
  action: z.enum(['sessions', 'send', 'read', 'reply']),
  to: z.string().optional()
    .describe('send: recipient mailbox id, as reported by action sessions'),
  text: z.string().optional()
    .describe('send/reply: the message body'),
  replyTo: z.string().optional()
    .describe('reply: id of the message answered; the reply goes to its sender'),
  waitForReplyMs: z.number().int().positive().max(300000).optional()
    .describe('send/reply: hold the call open until any message arrives here, for at most this many ms'),
  pollIntervalMs: z.number().int().min(100).max(5000).optional()
    .describe('send/reply: interval between mailbox checks while waiting (default 500)'),
}).strict();

type MessageArgs = z.infer<typeof messageSchema>;

const DEFAULT_POLL_INTERVAL_MS = 500;

function buildMeta(action: MessageArgs['action'], self: string, extra: Partial<MessageToolMeta>): ToolResponseMeta {
  return {
    tool: 'message',
    action,
    timestamp: Date.now(),
    message: { action, self, ...extra },
  };
}

/** One line per message, newest last, for the rendered response. */
function formatMessages(messages: SessionMessage[]): string {
  return messages
    .map(m => `- [${m.id.slice(0, 8)}] from ${m.from}${m.replyTo ? ` (reply to ${m.replyTo.slice(0, 8)})` : ''} at ${m.at}\n  ${m.text}`)
    .join('\n');
}

export function createMessageTools() {
  return {
    message: createTool(
      'Text between two devharness sessions on this machine. Actions: sessions (who is reachable), send (write to another session, optionally holding the call open for a reply), read (take new messages), reply (answer a message by id).',
      messageSchema,
      async (args: MessageArgs, abortSignal?: AbortSignal) => {
        const self = resolveSessionName(getSessionInfo()?.shortId);
        const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

        switch (args.action) {
          // ---- sessions ------------------------------------------------------
          case 'sessions': {
            // The endpoint records are written by the live child and swept by
            // a pid check, so they carry both identity and liveness. The
            // dashboard hub holds the same sessions but prunes only on a clean
            // socket close, which reports a replaced child as still running.
            const records = listSessionRecords();
            const mailboxIds = await listMailboxIds();

            const rows: NonNullable<MessageToolMeta['sessions']> = [];
            const seen = new Set<string>();

            for (const record of records) {
              const id = record.shortId ?? `pid-${record.pid}`;
              if (seen.has(id)) continue;
              seen.add(id);
              rows.push({ id, pid: record.pid, cwd: record.cwd, live: true, self: id === self });
            }

            // A mailbox with no session behind it is one that has exited.
            // Listing it keeps a reply to a dead session visible, not silent.
            for (const id of mailboxIds) {
              if (seen.has(id)) continue;
              seen.add(id);
              rows.push({ id, live: false, self: id === self });
            }

            if (!seen.has(self)) {
              rows.push({ id: self, pid: process.pid, live: true, self: true });
            }

            const response = createSuccessResponse('MESSAGE_SESSIONS', {
              self,
              mailboxPath: getMailboxPath(self),
              messagesDir: getMessagesDir(),
              eventStreamPath: getEventStreamPath(self),
              sessionList: rows
                .map(r => `- ${r.id}${r.self ? ' (this session)' : ''} - ${r.live ? 'live' : 'no process'}${r.cwd ? ` - ${r.cwd}` : ''}`)
                .join('\n'),
              count: rows.length,
            });
            return { ...response, _meta: buildMeta('sessions', self, { sessions: rows }) };
          }

          // ---- send / reply --------------------------------------------------
          case 'send':
          case 'reply': {
            if (!args.text) {
              return createErrorResponse('MESSAGE_INVALID_ARGS', {
                message: `message({ action: '${args.action}' }) requires text.`,
              });
            }

            let target: string;
            let replyTo: string | undefined;

            if (args.action === 'reply') {
              if (!args.replyTo) {
                return createErrorResponse('MESSAGE_INVALID_ARGS', {
                  message: "message({ action: 'reply' }) requires replyTo - the id of the message being answered.",
                });
              }
              const own = await readMailbox(self);
              const original = own.find(m => m.id === args.replyTo || m.id.startsWith(args.replyTo!));
              if (!original) {
                return createErrorResponse('MESSAGE_TARGET_UNKNOWN', {
                  target: args.replyTo,
                  reason: `No message with id "${args.replyTo}" in this session's mailbox`,
                  self,
                });
              }
              target = original.from;
              replyTo = original.id;
            } else {
              if (!args.to) {
                return createErrorResponse('MESSAGE_INVALID_ARGS', {
                  message: "message({ action: 'send' }) requires to - a mailbox id from message({ action: 'sessions' }).",
                });
              }
              target = args.to;
            }

            if (!isValidMailboxId(target)) {
              return createErrorResponse('MESSAGE_TARGET_UNKNOWN', {
                target,
                reason: 'Not a valid mailbox id (letters, digits, dot, dash, underscore; 64 chars max)',
                self,
              });
            }
            if (target === self) {
              return createErrorResponse('MESSAGE_INVALID_ARGS', {
                message: `"${target}" is this session's own mailbox - a message to it would never reach another agent.`,
              });
            }

            // The line count is taken BEFORE the append: a reply that lands
            // between the append and the first poll sits past this offset and
            // is returned, rather than being counted as already-read.
            const fromLine = args.waitForReplyMs ? (await readMailbox(self)).length : 0;
            // Where `read` had got to. A mailbox with unread lines sits behind
            // fromLine, and advancing the cursor past them would drop them.
            const cursorBefore = args.waitForReplyMs ? await readCursor(self) : 0;

            const sent = await sendMessage({
              from: self,
              fromCwd: getProjectDir(),
              to: target,
              text: args.text,
              ...(replyTo ? { replyTo } : {}),
            });

            // The recipient's Monitor watches its event stream, not its
            // mailbox, so the arrival is announced there.
            await appendEvent(target, 'message', {
              from: self,
              id: sent.id,
              detail: `Message from ${self}: ${args.text.slice(0, 120)}`,
              resolve: "message({ action: 'read' })",
            });

            // A typo mints a mailbox nothing ever reads, and nothing removes
            // one, so the sessions listing grows a fictional peer per slip.
            // Refusing would block a genuine first message to a session whose
            // server is suspended, which has neither record nor mailbox, so the
            // state is reported rather than enforced.
            const targetListening = listSessionRecords()
              .some(r => (r.shortId ?? `pid-${r.pid}`) === target);

            if (!args.waitForReplyMs) {
              const response = createSuccessResponse('MESSAGE_SENT', {
                to: target,
                id: sent.id,
                shortId: sent.id.slice(0, 8),
                mailboxPath: getMailboxPath(target),
                deliveryNote: targetListening
                  ? ''
                  : `\n\n**No session is listening as \`${target}\` right now.** It reads this when it next starts, or the id is a typo and nothing ever will - check \`message({ action: 'sessions' })\`.`,
              });
              return { ...response, _meta: buildMeta(args.action, self, { sent, targetListening }) };
            }

            const waitStart = Date.now();
            const received = await waitForMailbox(self, fromLine, {
              timeoutMs: args.waitForReplyMs,
              pollIntervalMs,
              abortSignal,
            });
            const waitElapsedMs = Date.now() - waitStart;

            if (received.length === 0) {
              return {
                ...createErrorResponse('MESSAGE_REPLY_TIMEOUT', {
                  to: target,
                  timeoutMs: args.waitForReplyMs,
                  id: sent.id.slice(0, 8),
                  self,
                  mailboxPath: getMailboxPath(self),
                }),
                _meta: buildMeta(args.action, self, { sent, waitTimedOut: true, waitElapsedMs }),
              };
            }

            // The wait consumed these lines, so the cursor moves past them and
            // a later `read` does not hand back the same messages - but only
            // when `read` had already caught up. With unread lines behind
            // fromLine there is no cursor value that means "those unread, these
            // read", so the cursor stays put and `read` returns the backlog
            // together with what the wait already showed. Repeating a message
            // is recoverable; losing one is not.
            if (cursorBefore >= fromLine) {
              await writeCursor(self, fromLine + received.length);
            }

            const response = createSuccessResponse('MESSAGE_REPLY_RECEIVED', {
              to: target,
              count: received.length,
              elapsedMs: waitElapsedMs,
              messageList: formatMessages(received),
              // A cursor cannot express "those unread, these read", so with a
              // backlog behind fromLine it stays put and `read` hands these
              // back a second time. Acting on them twice is the failure that
              // silence here would cause.
              repeatNote: cursorBefore < fromLine
                ? `\n\n**Unread messages sit behind these**, so the cursor did not move: \`message({ action: 'read' })\` returns the backlog AND repeats the message(s) above once. Treat a repeat as already handled.`
                : '',
            });
            return {
              ...response,
              _meta: buildMeta(args.action, self, { sent, received, waitTimedOut: false, waitElapsedMs }),
            };
          }

          // ---- read ----------------------------------------------------------
          case 'read': {
            const all = await readMailbox(self);
            const cursor = await readCursor(self);
            // A mailbox deleted while a cursor survives would slice past the
            // end and return nothing forever; clamp to the current length.
            const from = Math.min(cursor, all.length);
            const fresh = all.slice(from);
            await writeCursor(self, all.length);

            const response = createSuccessResponse('MESSAGE_INBOX', {
              self,
              count: fresh.length,
              total: all.length,
              mailboxPath: getMailboxPath(self),
              messageList: fresh.length ? formatMessages(fresh) : '(nothing new)',
            });
            return { ...response, _meta: buildMeta('read', self, { received: fresh }) };
          }
        }
      }
    ),
  };
}
