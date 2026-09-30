import { describe, it, expect } from 'vitest';
import { startProxyFor, shareProxy, getProxy } from '../proxy/registry.js';
import { createProxyTools } from './proxy-tools.js';

const text = (r: any) => r.content.map((c: any) => c.text).join('\n');

describe('proxy stop', () => {
  it('drops one name of a shared proxy and leaves it running for the other', async () => {
    const { proxy: running } = await startProxyFor('stop first tab');
    shareProxy('stop first tab', 'stop second tab');
    const { proxy } = createProxyTools();

    const result: any = await proxy.handler({ action: 'stop', connectionReason: 'stop second tab' } as any);

    expect(getProxy('stop second tab')).toBeUndefined();
    expect(getProxy('stop first tab')).toBe(running);
    expect(text(result)).toContain('stop first tab');
    await proxy.handler({ action: 'stop', connectionReason: 'stop first tab' } as any);
  });

  it('stops the proxy when the name is the last one holding it', async () => {
    const { proxy: running } = await startProxyFor('stop only tab');
    const { proxy } = createProxyTools();

    const result: any = await proxy.handler({ action: 'stop', connectionReason: 'stop only tab' } as any);

    expect(getProxy('stop only tab')).toBeUndefined();
    expect((running as any).front.listening).toBe(false);
    expect(result._meta.proxy).toMatchObject({ stopped: true, remaining: [] });
  });
});
