/**
 * The proxies this session has started, one per browser that asked for one.
 *
 * Kept here rather than on the connection, because a proxy outlives the
 * connection that launched it: a hold is meant to persist while someone
 * browses, and a browse crosses tabs.
 */
import { InterceptProxy } from './intercept-proxy.js';

const proxies = new Map<string, InterceptProxy>();

export async function startProxyFor(reference: string): Promise<{
  proxy: InterceptProxy;
  chromeArgs: string[];
}> {
  const existing = proxies.get(reference);
  if (existing) return { proxy: existing, chromeArgs: [] };

  const proxy = new InterceptProxy();
  const { chromeArgs } = await proxy.start();
  proxies.set(reference, proxy);
  return { proxy, chromeArgs };
}

export function getProxy(reference: string): InterceptProxy | undefined {
  return proxies.get(reference);
}

export function listProxies(): string[] {
  return [...proxies.keys()];
}

export async function stopProxyFor(reference: string): Promise<boolean> {
  const proxy = proxies.get(reference);
  if (!proxy) return false;
  proxies.delete(reference);
  await proxy.stop().catch(() => {});
  return true;
}
