/**
 * The one way devharness opens a CDP session on a page. Every command sent
 * through it that runs source in the page goes out tagged as devharness's own
 * (`own-script.ts`), so a pause a hold arms on an idle page steps out of it
 * rather than standing inside devharness's own call, where the call would never
 * return. A tag left to each caller was missing from eight calls at once.
 */

import type { CDPSession } from 'puppeteer-core';
import { tagPageSource } from './own-script.js';

interface SessionSource {
  createCDPSession(): Promise<CDPSession>;
}

interface Sends {
  send: (method: any, params?: any, ...rest: any[]) => any;
}

/** A session on `target` (a page or a target), its page source tagged on the way out. */
export async function openSession(target: SessionSource): Promise<CDPSession> {
  return tagSession(await target.createCDPSession());
}

/**
 * `session` behind a view whose `send` tags page source. The session itself is
 * left as it is; every other member is read from it and bound to it, so its
 * private fields stand.
 */
export function tagSession<S extends Sends>(session: S): S {
  const send = (method: string, params?: unknown, ...rest: unknown[]) => session.send(method, tagPageSource(method, params), ...rest);
  return new Proxy(session, {
    get(target, key) {
      if (key === 'send') return send;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * A chrome-remote-interface client tagged in place. Its domain methods
 * (`client.Runtime.evaluate`) call `send` on the client itself, which a view in
 * front of it never sees, so the client's own `send` is replaced; the client is
 * one devharness made and holds alone.
 */
export function tagClient<C extends Sends>(client: C): C {
  const send = client.send.bind(client);
  client.send = ((method: string, params?: unknown, ...rest: unknown[]) => send(method, tagPageSource(method, params), ...rest)) as C['send'];
  return client;
}
