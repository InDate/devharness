/**
 * What a command owns at the boundary, and the three mechanisms that decide it.
 *
 * A command's consequences arrive after it returns, so something has to say
 * which of them it caused. In order of precedence:
 *
 * 1. The cursor clears at the command's return, so a bucket covers its own
 *    command and nothing later, and traffic crossing afterwards is available
 *    to be read as the app's own.
 * 2. What the page reports accounts for traffic that starts after the return -
 *    a subresource takes the stamp of the document that named it, a timer-
 *    rooted request or send owns nothing. These are measurements.
 * 3. The settle window holds the returning command's cursor over what starts
 *    inside it, attributing by position. Last resort, for traffic the page
 *    cannot report on (a worker's first line, a load before the session
 *    attached, a frozen prototype).
 *
 * Each case below fails if its mechanism stops working, and the failure is
 * named beside it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import {
  startProxyFor, stopProxyFor, markNextCommand, releaseCommand, forgetCursor,
} from './registry.js';
import { levelOf, ownershipWeight } from './intercept-proxy.js';

let origin: Server;
let originPort = 0;

beforeAll(async () => {
  origin = createServer((req, res) => {
    // One path answers slowly, so its bytes cross after the command that asked
    // for the page has already returned and released its boundary.
    const late = (req.url ?? '').includes('late');
    setTimeout(() => { res.writeHead(200); res.end('ok'); }, late ? 120 : 0);
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  originPort = (origin.address() as { port: number }).port;
});

afterAll(async () => {
  forgetCursor();
  await stopProxyFor('boundary-under-test');
  await new Promise<void>(resolve => origin.close(() => resolve()));
});

function get(port: number, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'GET',
      path: `http://127.0.0.1:${originPort}${path}`,
      headers: { Host: `127.0.0.1:${originPort}` },
    }, res => { res.on('data', () => {}); res.on('end', () => resolve()); });
    req.on('error', reject);
    req.end();
  });
}

async function proxyUnderTest() {
  forgetCursor();
  const { proxy } = await startProxyFor('boundary-under-test', `http://127.0.0.1:${originPort}`);
  return { proxy, port: proxy.listenPort };
}

describe('a bucket that closes when its command returns', () => {
  it('holds what crossed under the command', async () => {
    const { proxy, port } = await proxyUnderTest();
    await markNextCommand({ kind: 'command', index: 12 });
    await get(port, '/under-twelve');
    await releaseCommand(0, 0, 'boundary-under-test');

    const owned = proxy.eventsForCommand(12).map(e => e.url);
    expect(owned.some(u => u.includes('/under-twelve'))).toBe(true);
  });

  it('leaves what crossed after the release owned by no command', async () => {
    // Without the release a bucket runs until the next command marks, so it
    // holds the whole pause between two commands - on the last recorded step,
    // every push that arrives while a person reads the screen.
    const { proxy, port } = await proxyUnderTest();
    await markNextCommand({ kind: 'command', index: 13 });
    await releaseCommand(0, 0, 'boundary-under-test');
    await get(port, '/after-thirteen');

    const owned = proxy.eventsForCommand(13).map(e => e.url);
    const seen = proxy.eventsIn().map(e => e.url);
    expect(owned.some(u => u.includes('/after-thirteen'))).toBe(false);
    // On the record and owned by nothing, which is what a reading of the app's
    // own traffic needs: dropping it instead would lose the evidence.
    expect(seen.some(u => u.includes('/after-thirteen'))).toBe(true);
  });
});

describe('what the page reports about a request', () => {
  it('gives a subresource the stamp of the document that named it', async () => {
    // The parser reaches a subresource whenever it reaches it, which is often
    // after the navigate returned. Attributed by position it would belong to
    // no step at all; the document it was named by says which step it is.
    const { proxy, port } = await proxyUnderTest();
    const documentUrl = `http://127.0.0.1:${originPort}/page`;

    await markNextCommand({ kind: 'command', index: 14 });
    await get(port, '/page');
    proxy.noteInitiator('GET', documentUrl, 'other', Date.now());
    await releaseCommand(0, 0, 'boundary-under-test');

    const inFlight = get(port, '/late.js');
    proxy.noteInitiator(
      'GET', `http://127.0.0.1:${originPort}/late.js`, 'parser', Date.now(), documentUrl);
    await inFlight;

    const owned = proxy.eventsForCommand(14).map(e => e.url);
    expect(owned.some(u => u.includes('/page'))).toBe(true);
    expect(owned.some(u => u.includes('/late.js'))).toBe(true);
  });

  it('leaves a timer-rooted request owned by nothing, whatever was in flight', async () => {
    // A poll that fires during a command crossed while that command ran and
    // was caused by none of it. Position cannot tell those apart; the page can.
    const { proxy, port } = await proxyUnderTest();
    await markNextCommand({ kind: 'command', index: 15 });
    const inFlight = get(port, '/poll');
    proxy.noteInitiator('GET', `http://127.0.0.1:${originPort}/poll`, 'timer', Date.now());
    await inFlight;

    const poll = proxy.eventsIn().find(e => e.url.includes('/poll'))!;
    expect(poll.evidence?.initiator).toBe('timer');
    expect(levelOf(poll)).toBe('unprompted');
    expect(ownershipWeight(poll)).toBe(0);
    expect(proxy.eventsForCommand(15).some(e => e.url.includes('/poll'))).toBe(false);
  });

  it('gives a request started inside a trusted dispatch the command that drove it', async () => {
    // The case the settle window exists for on a page the harness can reach: a
    // click handler whose fetch leaves after the command returned. Owned by
    // position it belongs to nothing; the dispatch says which command it was.
    const { proxy, port } = await proxyUnderTest();
    await markNextCommand({ kind: 'command', index: 18 });
    await releaseCommand(0, 0, 'boundary-under-test');

    const inFlight = get(port, '/late.js?clicked=1');
    proxy.noteInitiator(
      'GET', `http://127.0.0.1:${originPort}/late.js?clicked=1`, 'input', Date.now());
    await inFlight;

    const owned = proxy.eventsForCommand(18).map(e => e.url);
    expect(owned.some(u => u.includes('clicked=1'))).toBe(true);
  });

  it('lets a trusted dispatch outrank the class read from the stack', async () => {
    // CDP reads a stack and cannot see that an event was dispatching, so a
    // click handler's fetch reads as plain script there. The page's answer is
    // the one with the command in it.
    const { proxy, port } = await proxyUnderTest();
    await markNextCommand({ kind: 'command', index: 19 });
    const inFlight = get(port, '/both-report');
    const url = `http://127.0.0.1:${originPort}/both-report`;
    proxy.noteInitiator('GET', url, 'script', Date.now());
    await inFlight;
    proxy.noteInitiator('GET', url, 'input', Date.now());

    const event = proxy.eventsIn().find(e => e.url.includes('/both-report'))!;
    expect(event.evidence?.initiator).toBe('input');
  });

  it('owns a gesture-driven request when the stack says script as well', async () => {
    // Production always has both: CDP reports what the stack shows, and the
    // page reports the dispatch. A test with only the page's report never
    // exercises the precedence, and the case that matters is the one after the
    // release, where the stack's answer carries no command at all.
    const { proxy, port } = await proxyUnderTest();
    await markNextCommand({ kind: 'command', index: 20 });
    await releaseCommand(0, 0, 'boundary-under-test');

    const url = `http://127.0.0.1:${originPort}/late.js?both=1`;
    const inFlight = get(port, '/late.js?both=1');
    proxy.noteInitiator('GET', url, 'script', Date.now());
    proxy.noteInitiator('GET', url, 'input', Date.now());
    await inFlight;

    const event = proxy.eventsIn().find(e => e.url.includes('both=1'))!;
    expect(event.evidence?.initiator).toBe('input');
    expect(proxy.eventsForCommand(20).some(e => e.url.includes('both=1'))).toBe(true);
  });

  it('joins a report that arrives before its request crosses', async () => {
    // The report travels a CDP session and the bytes travel the wire, so
    // either can be first. A join in one direction only would miss half.
    const { proxy, port } = await proxyUnderTest();
    await markNextCommand({ kind: 'command', index: 16 });
    proxy.noteInitiator('GET', `http://127.0.0.1:${originPort}/ahead`, 'timer', Date.now());
    await get(port, '/ahead');

    const ahead = proxy.eventsIn().find(e => e.url.includes('/ahead'))!;
    expect(ahead.evidence?.initiator).toBe('timer');
  });
});

describe('the settle window, where the page reports nothing', () => {
  it('holds the returning command over traffic that starts inside it', async () => {
    // The fallback: a worker's first line, or a load from before the session
    // attached, reports no root, so position is all that is left. The cursor
    // stays put for the wait rather than clearing at once.
    const { proxy, port } = await proxyUnderTest();
    await markNextCommand({ kind: 'command', index: 17 });

    const releasing = releaseCommand(200, 1000, 'boundary-under-test');
    await get(port, '/inside-the-window');
    await releasing;
    await get(port, '/after-the-window');

    const owned = proxy.eventsForCommand(17).map(e => e.url);
    expect(owned.some(u => u.includes('/inside-the-window'))).toBe(true);
    expect(owned.some(u => u.includes('/after-the-window'))).toBe(false);
  });
});
