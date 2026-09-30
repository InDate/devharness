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

describe('proxy actions missing what they act on', () => {
  it('refuse rather than answer every request, drop every message, or look up no id', async () => {
    const { proxy: running } = await startProxyFor('pin guard tab');
    const { proxy } = createProxyTools();

    for (const args of [
      { action: 'answer', value: '{}' },
      { action: 'answerFrame' },
      { action: 'body' },
      { action: 'withdraw' },
    ]) {
      const result: any = await proxy.handler({ ...args, connectionReason: 'pin guard tab' } as any);
      expect(result.isError, args.action).toBe(true);
    }
    expect(running.listPins()).toEqual([]);
    expect(running.listFramePins()).toEqual([]);
    await proxy.handler({ action: 'stop', connectionReason: 'pin guard tab' } as any);
  });
});
