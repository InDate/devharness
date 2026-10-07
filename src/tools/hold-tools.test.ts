/**
 * What the hold tool answers.
 *
 * A name with nothing attached to it - no debugger, no bench, no proxy - is
 * refused: answered with "Nothing is held", a replay step against a browser
 * that never came up passes (#115). A release names the layers it released,
 * because the reading after it - "Nothing is held" - reads the same whether
 * the release took a hold away or found none to take.
 */
import { describe, it, expect } from 'vitest';
import { createHoldTools } from './hold-tools.js';
import { attachLayer } from '../hold.js';

const { hold } = createHoldTools();
const text = (res: any) => res.content[0].text as string;

function attachCode(connection: string) {
  return attachLayer(connection, 'code', {
    engage: async () => ({ armed: true }),
    disengage: async () => {},
  });
}

describe('the hold tool on a name with nothing attached', () => {
  it('refuses status, hold and release', async () => {
    for (const action of ['status', 'hold', 'release'] as const) {
      const res: any = await hold.handler({ action, connection: 'never-launched' } as any);
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('Nothing on "never-launched" can be held');
    }
  });
});

describe('a release', () => {
  it('names the layer it released', async () => {
    const detach = attachCode('release-names-layer');
    await hold.handler({ action: 'hold', connection: 'release-names-layer', layers: ['code'] } as any);

    const res: any = await hold.handler({ action: 'release', connection: 'release-names-layer' } as any);

    expect(text(res)).toMatch(/^Released code \(code\)\.\nNothing is held on "release-names-layer"\./);
    expect(res._meta.released).toEqual(['code']);
    detach();
  });

  it('says it released nothing where no layer was held', async () => {
    const detach = attachCode('release-finds-none');

    const res: any = await hold.handler({ action: 'release', connection: 'release-finds-none' } as any);

    expect(text(res)).toMatch(/^Released nothing: no named layer was held\./);
    expect(res._meta.released).toEqual([]);
    detach();
  });
});
