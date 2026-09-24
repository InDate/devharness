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

/** Whether the proxy would refuse this host, read off its own allow list. */
function reaches(proxy: InterceptProxy, host: string): boolean {
  const allowed = proxy.listAllowedHosts();
  if (allowed.length === 0) return true;
  const [name, port] = host.toLowerCase().split(':');
  return allowed.some(entry => {
    const [wantHost, wantPort] = entry.toLowerCase().split(':');
    const hostMatches = name === wantHost || name.endsWith(`.${wantHost}`);
    return hostMatches && (wantPort === undefined || wantPort === port);
  });
}

describe('the hosts a proxied browser may reach', () => {
  it('reaches everything until a sequence scopes it', () => {
    const proxy = new InterceptProxy();
    expect(proxy.listAllowedHosts()).toEqual([]);
    expect(reaches(proxy, 'localhost:3102')).toBe(true);
  });

  it('keeps reaching the app when the bench is allowed through', () => {
    // The bench travels the same proxy as the app. Adding it to an empty allow
    // list would make it the only host allowed, and the app under test would
    // be refused by the act of opening the bench beside it.
    const proxy = new InterceptProxy();
    proxy.allowQuietly(['127.0.0.1:56019']);

    expect(reaches(proxy, 'localhost:3102')).toBe(true);
    expect(reaches(proxy, 'example.test')).toBe(true);
  });

  it('holds the bench open once a sequence names its hosts', () => {
    const proxy = new InterceptProxy();
    proxy.allowQuietly(['127.0.0.1:56019']);
    proxy.allowOnly(['localhost:3102']);

    expect(reaches(proxy, 'localhost:3102')).toBe(true);
    expect(reaches(proxy, '127.0.0.1:56019')).toBe(true);
    expect(reaches(proxy, 'example.test')).toBe(false);
  });

  it('holds the bench open whichever order the two calls arrive in', () => {
    const proxy = new InterceptProxy();
    proxy.allowOnly(['localhost:3102']);
    proxy.allowQuietly(['127.0.0.1:56019']);

    expect(reaches(proxy, '127.0.0.1:56019')).toBe(true);
    expect(reaches(proxy, 'localhost:3102')).toBe(true);
    expect(reaches(proxy, 'example.test')).toBe(false);
  });
});
