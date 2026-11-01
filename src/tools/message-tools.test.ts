/**
 * Tests for the `message` tool and its mailbox transport.
 *
 * Every case runs against a temporary DEVHARNESS_DIR, so the mailboxes are the
 * real files the tool writes in production rather than a mock of them - the
 * cursor and the blocking wait are both defined by what is on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializePaths } from '../helpers/paths.js';
import { setSessionInfo } from './dashboard-tools.js';
import { createMessageTools } from './message-tools.js';
import {
  isValidMailboxId,
  getMailboxPath,
  readMailbox,
  readCursor,
  sendMessage,
  waitForMailbox,
} from '../session-messages.js';

let dir: string;
let previousDir: string | undefined;
let previousSessionId: string | undefined;

function asSession(shortId: string): void {
  setSessionInfo({
    sessionId: `${shortId}-full-uuid`,
    shortId,
    sessionFile: `/tmp/${shortId}.jsonl`,
    detectedAt: Date.now(),
  });
}

const { message } = createMessageTools();

beforeEach(() => {
  previousDir = process.env.DEVHARNESS_DIR;
  previousSessionId = process.env.CLAUDE_CODE_SESSION_ID;
  dir = mkdtempSync(join(tmpdir(), 'devharness-messages-'));
  process.env.DEVHARNESS_DIR = dir;
  // The real value on the machine running the suite would otherwise decide
  // every mailbox id below.
  process.env.CLAUDE_CODE_SESSION_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
  initializePaths();
  asSession('aaaaaaaa');
});

afterEach(() => {
  setSessionInfo(null);
  if (previousDir === undefined) delete process.env.DEVHARNESS_DIR;
  else process.env.DEVHARNESS_DIR = previousDir;
  if (previousSessionId === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = previousSessionId;
  initializePaths();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mailbox ids
// ---------------------------------------------------------------------------

describe('isValidMailboxId', () => {
  it('accepts the short-id and pid forms the tool produces', () => {
    expect(isValidMailboxId('aaaaaaaa')).toBe(true);
    expect(isValidMailboxId('pid-12345')).toBe(true);
  });

  it('rejects ids that would write outside the messages directory', () => {
    expect(isValidMailboxId('../escape')).toBe(false);
    expect(isValidMailboxId('a/b')).toBe(false);
    expect(isValidMailboxId('..')).toBe(false);
    expect(isValidMailboxId('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

describe('mailbox transport', () => {
  it('appends one JSON line per message to the recipient', async () => {
    await sendMessage({ from: 'aaaaaaaa', to: 'bbbbbbbb', text: 'first' });
    await sendMessage({ from: 'aaaaaaaa', to: 'bbbbbbbb', text: 'second' });

    const raw = readFileSync(getMailboxPath('bbbbbbbb'), 'utf-8');
    expect(raw.trimEnd().split('\n')).toHaveLength(2);

    const messages = await readMailbox('bbbbbbbb');
    expect(messages.map(m => m.text)).toEqual(['first', 'second']);
    expect(messages[0].from).toBe('aaaaaaaa');
    expect(messages[0].to).toBe('bbbbbbbb');
  });

  it('skips a torn line instead of losing every message after it', async () => {
    await sendMessage({ from: 'aaaaaaaa', to: 'bbbbbbbb', text: 'good' });
    const { appendFileSync } = await import('fs');
    appendFileSync(getMailboxPath('bbbbbbbb'), '{not json\n');
    await sendMessage({ from: 'aaaaaaaa', to: 'bbbbbbbb', text: 'after' });

    const messages = await readMailbox('bbbbbbbb');
    expect(messages.map(m => m.text)).toEqual(['good', 'after']);
  });

  it('reads an absent mailbox as empty', async () => {
    expect(await readMailbox('nobody')).toEqual([]);
    expect(existsSync(getMailboxPath('nobody'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waitForMailbox
// ---------------------------------------------------------------------------

describe('waitForMailbox', () => {
  it('returns the messages past the offset once one lands', async () => {
    const pending = waitForMailbox('aaaaaaaa', 0, { timeoutMs: 5000, pollIntervalMs: 25 });
    setTimeout(() => { void sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'here' }); }, 50);

    const received = await pending;
    expect(received.map(m => m.text)).toEqual(['here']);
  });

  it('returns empty when the timeout elapses with nothing new', async () => {
    const received = await waitForMailbox('aaaaaaaa', 0, { timeoutMs: 150, pollIntervalMs: 25 });
    expect(received).toEqual([]);
  });

  it('ignores messages at or before the offset', async () => {
    await sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'old' });
    const received = await waitForMailbox('aaaaaaaa', 1, { timeoutMs: 150, pollIntervalMs: 25 });
    expect(received).toEqual([]);
  });

  it('throws an abort-shaped error when the signal aborts mid-wait', async () => {
    const controller = new AbortController();
    const pending = waitForMailbox('aaaaaaaa', 0, {
      timeoutMs: 5000,
      pollIntervalMs: 25,
      abortSignal: controller.signal,
    });
    setTimeout(() => controller.abort(), 40);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ---------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------

describe('message send', () => {
  it('writes to the target mailbox and reports the id', async () => {
    const res = await message.handler({ action: 'send', to: 'bbbbbbbb', text: 'hello' });

    expect(res.isError).toBeFalsy();
    expect(res._meta.message.sent.to).toBe('bbbbbbbb');
    expect(res._meta.message.sent.from).toBe('aaaaaaaa');
    expect(res._meta.message.self).toBe('aaaaaaaa');

    const delivered = await readMailbox('bbbbbbbb');
    expect(delivered.map(m => m.text)).toEqual(['hello']);
  });

  it('refuses a message addressed to this session', async () => {
    const res = await message.handler({ action: 'send', to: 'aaaaaaaa', text: 'hello' });
    expect(res.isError).toBe(true);
    expect(res._errorId).toBe('MESSAGE_INVALID_ARGS');
  });

  it('refuses an id that would escape the messages directory', async () => {
    const res = await message.handler({ action: 'send', to: '../escape', text: 'hello' });
    expect(res.isError).toBe(true);
    expect(res._errorId).toBe('MESSAGE_TARGET_UNKNOWN');
  });

  it('requires text', async () => {
    const res = await message.handler({ action: 'send', to: 'bbbbbbbb' });
    expect(res.isError).toBe(true);
    expect(res._errorId).toBe('MESSAGE_INVALID_ARGS');
  });
});

describe('message send with waitForReplyMs', () => {
  it('returns once anything lands in this session\'s mailbox', async () => {
    const pending = message.handler({
      action: 'send', to: 'bbbbbbbb', text: 'ping', waitForReplyMs: 5000, pollIntervalMs: 25,
    });
    setTimeout(() => { void sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'pong' }); }, 50);

    const res = await pending;
    expect(res.isError).toBeFalsy();
    expect(res._meta.message.waitTimedOut).toBe(false);
    expect(res._meta.message.received.map((m: any) => m.text)).toEqual(['pong']);
  });

  it('fails with MESSAGE_REPLY_TIMEOUT when nothing answers', async () => {
    const res = await message.handler({
      action: 'send', to: 'bbbbbbbb', text: 'ping', waitForReplyMs: 150, pollIntervalMs: 25,
    });
    expect(res.isError).toBe(true);
    expect(res._errorId).toBe('MESSAGE_REPLY_TIMEOUT');
    expect(res._meta.message.waitTimedOut).toBe(true);
  });

  it('leaves a message that arrived before the send unconsumed by the wait', async () => {
    await sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'earlier' });

    const res = await message.handler({
      action: 'send', to: 'bbbbbbbb', text: 'ping', waitForReplyMs: 150, pollIntervalMs: 25,
    });
    expect(res._errorId).toBe('MESSAGE_REPLY_TIMEOUT');

    const inbox = await message.handler({ action: 'read' });
    expect(inbox._meta.message.received.map((m: any) => m.text)).toEqual(['earlier']);
  });

  it('keeps an unread backlog readable when the wait succeeds', async () => {
    await sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'earlier-unread' });

    const pending = message.handler({
      action: 'send', to: 'bbbbbbbb', text: 'ping', waitForReplyMs: 5000, pollIntervalMs: 25,
    });
    setTimeout(() => { void sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'pong' }); }, 50);
    expect((await pending).isError).toBeFalsy();

    // The backlog is what must survive; the waited message repeating is the
    // price of a cursor that cannot express a hole.
    const inbox = await message.handler({ action: 'read' });
    expect(inbox._meta.message.received.map((m: any) => m.text)).toEqual(['earlier-unread', 'pong']);

    // Exactly once - a second read is empty, not another repeat.
    const again = await message.handler({ action: 'read' });
    expect(again._meta.message.received).toEqual([]);
  });

  it('names in the response that the waited message comes back once', async () => {
    await sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'earlier-unread' });

    const pending = message.handler({
      action: 'send', to: 'bbbbbbbb', text: 'ping', waitForReplyMs: 5000, pollIntervalMs: 25,
    });
    setTimeout(() => { void sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'pong' }); }, 50);

    const res = await pending;
    expect(res.content[0].text).toContain('repeats the message');
  });

  it('leaves repeats unmentioned when the mailbox was already caught up', async () => {
    const pending = message.handler({
      action: 'send', to: 'bbbbbbbb', text: 'ping', waitForReplyMs: 5000, pollIntervalMs: 25,
    });
    setTimeout(() => { void sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'pong' }); }, 50);

    const res = await pending;
    expect(res.content[0].text).not.toContain('repeats the message');
  });

  it('advances the cursor past what the wait returned', async () => {
    const pending = message.handler({
      action: 'send', to: 'bbbbbbbb', text: 'ping', waitForReplyMs: 5000, pollIntervalMs: 25,
    });
    setTimeout(() => { void sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'pong' }); }, 50);
    await pending;

    expect(await readCursor('aaaaaaaa')).toBe(1);
    const inbox = await message.handler({ action: 'read' });
    expect(inbox._meta.message.received).toEqual([]);
  });
});

describe('waitForReplyMs shorter than one poll interval', () => {
  it('still polls, rather than timing out before the first check', async () => {
    const pending = message.handler({
      action: 'send', to: 'bbbbbbbb', text: 'ping', waitForReplyMs: 400, pollIntervalMs: 500,
    });
    setTimeout(() => { void sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'pong' }); }, 100);

    const res = await pending;
    expect(res.isError).toBeFalsy();
    expect(res._meta.message.received.map((m: any) => m.text)).toEqual(['pong']);
  });
});

describe('message read', () => {
  it('returns each message once', async () => {
    await sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'one' });
    await sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'two' });

    const first = await message.handler({ action: 'read' });
    expect(first._meta.message.received.map((m: any) => m.text)).toEqual(['one', 'two']);

    const second = await message.handler({ action: 'read' });
    expect(second._meta.message.received).toEqual([]);

    await sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'three' });
    const third = await message.handler({ action: 'read' });
    expect(third._meta.message.received.map((m: any) => m.text)).toEqual(['three']);
  });

  it('returns nothing for a session that has received nothing', async () => {
    const res = await message.handler({ action: 'read' });
    expect(res.isError).toBeFalsy();
    expect(res._meta.message.received).toEqual([]);
  });
});

describe('message reply', () => {
  it('routes back to the sender of the message being answered', async () => {
    const incoming = await sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'question' });
    await message.handler({ action: 'read' });

    const res = await message.handler({ action: 'reply', replyTo: incoming.id, text: 'answer' });
    expect(res.isError).toBeFalsy();

    const theirs = await readMailbox('bbbbbbbb');
    expect(theirs.map(m => m.text)).toEqual(['answer']);
    expect(theirs[0].replyTo).toBe(incoming.id);
    expect(theirs[0].from).toBe('aaaaaaaa');
  });

  it('accepts the abbreviated id the response prints', async () => {
    const incoming = await sendMessage({ from: 'bbbbbbbb', to: 'aaaaaaaa', text: 'question' });
    const res = await message.handler({
      action: 'reply', replyTo: incoming.id.slice(0, 8), text: 'answer',
    });
    expect(res.isError).toBeFalsy();
    expect((await readMailbox('bbbbbbbb'))[0].replyTo).toBe(incoming.id);
  });

  it('fails when no message in this mailbox carries that id', async () => {
    const res = await message.handler({ action: 'reply', replyTo: 'deadbeef', text: 'answer' });
    expect(res.isError).toBe(true);
    expect(res._errorId).toBe('MESSAGE_TARGET_UNKNOWN');
  });

  it('requires replyTo', async () => {
    const res = await message.handler({ action: 'reply', text: 'answer' });
    expect(res.isError).toBe(true);
    expect(res._errorId).toBe('MESSAGE_INVALID_ARGS');
  });
});

describe('message sessions', () => {
  it('lists this session and every mailbox on disk when the hub is down', async () => {
    await sendMessage({ from: 'aaaaaaaa', to: 'bbbbbbbb', text: 'hello' });

    const res = await message.handler({ action: 'sessions' });
    expect(res.isError).toBeFalsy();

    const ids = res._meta.message.sessions.map((s: any) => s.id).sort();
    expect(ids).toEqual(['aaaaaaaa', 'bbbbbbbb']);

    const self = res._meta.message.sessions.find((s: any) => s.self);
    expect(self.id).toBe('aaaaaaaa');
    expect(res._meta.message.sessions.find((s: any) => s.id === 'bbbbbbbb').live).toBe(false);
  });
});

describe('mailbox identity', () => {
  it('takes the session id from the environment, so a rebuild that drops the detector result keeps it', async () => {
    const before = (await message.handler({ action: 'read' }))._meta.message.self;
    setSessionInfo(null);
    const after = (await message.handler({ action: 'read' }))._meta.message.self;
    expect(before).toBe('aaaaaaaa');
    expect(after).toBe('aaaaaaaa');
  });

  it('prefers the environment over a detector result that disagrees', async () => {
    asSession('zzzzzzzz');
    const res = await message.handler({ action: 'read' });
    expect(res._meta.message.self).toBe('aaaaaaaa');
  });

  it('falls back to the detector when the environment carries no session id', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    asSession('zzzzzzzz');
    const res = await message.handler({ action: 'read' });
    expect(res._meta.message.self).toBe('zzzzzzzz');
  });

  it('falls back to the pid form when neither source has an id', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    setSessionInfo(null);
    const res = await message.handler({ action: 'read' });
    expect(res._meta.message.self).toBe(`pid-${process.pid}`);
  });

  it('ignores an environment value that could escape the messages directory', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = '../../escape';
    setSessionInfo(null);
    const res = await message.handler({ action: 'read' });
    expect(res._meta.message.self).toBe(`pid-${process.pid}`);
  });
});
