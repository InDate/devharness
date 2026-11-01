/**
 * Which hosts a proxied browser may reach.
 *
 * An empty allow list means every host is reachable and only the blocked list
 * is consulted. Anything that pushes into that empty list inverts the default
 * for every other host at once, which is how opening the bench came to refuse
 * the app it was opened beside.
 */
import { describe, it, expect } from 'vitest';
import { InterceptProxy } from './intercept-proxy.js';

describe('the hosts a proxied browser may reach', () => {
  it('holds an empty allow list until a sequence scopes it, which reaches every host', () => {
    const proxy = new InterceptProxy();
    expect(proxy.listAllowedHosts()).toEqual([]);
  });

  it('keeps the allow list empty when the bench is allowed through', () => {
    // The bench travels the same proxy as the app. Adding it to an empty allow
    // list would make it the only host allowed, and the app under test would
    // be refused by the act of opening the bench beside it.
    const proxy = new InterceptProxy();
    proxy.allowQuietly(['127.0.0.1:56019']);

    expect(proxy.listAllowedHosts()).toEqual([]);
  });

  it('holds the bench beside the hosts a sequence names', () => {
    const proxy = new InterceptProxy();
    proxy.allowQuietly(['127.0.0.1:56019']);
    proxy.allowOnly(['localhost:3102']);

    expect(proxy.listAllowedHosts().sort()).toEqual(['127.0.0.1:56019', 'localhost:3102']);
  });

  it('holds the bench beside the named hosts whichever order the two calls arrive in', () => {
    const proxy = new InterceptProxy();
    proxy.allowOnly(['localhost:3102']);
    proxy.allowQuietly(['127.0.0.1:56019']);

    expect(proxy.listAllowedHosts().sort()).toEqual(['127.0.0.1:56019', 'localhost:3102']);
  });
});
