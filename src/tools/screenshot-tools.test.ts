import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fsp, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createScreenshotTools } from './screenshot-tools.js';
import { setWorkingDirOverride } from '../helpers/paths.js';

function makeScreenshot(page: Record<string, any>, opts: { paused?: boolean } = {}) {
  const cdpManager = {
    isConnected: () => true,
    getRuntimeType: () => 'chrome',
    isPaused: () => opts.paused === true,
    getPausedInfo: () => ({ paused: opts.paused === true, location: { url: 'app.js', lineNumber: 2 } }),
    waitForPause: () => new Promise(() => {}),
  };
  const fullPage = { url: () => 'http://shop.test/', evaluate: vi.fn(async () => true), ...page };
  const puppeteerManager = { isConnected: () => true, getPage: () => fullPage };
  const { screenshot } = createScreenshotTools(async () => ({ connection: {}, cdpManager, puppeteerManager }));
  return screenshot;
}

const on = { connectionReason: 'shop-web-app' };
let dir: string;

beforeAll(async () => {
  dir = await fsp.mkdtemp(join(tmpdir(), 'screenshot-tools-'));
  setWorkingDirOverride(dir);
});
afterAll(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

describe('screenshot', () => {
  it('reports an element capture that throws as failed, not as a captured image', async () => {
    const screenshot = makeScreenshot({
      $: vi.fn(async () => ({ screenshot: vi.fn(async () => { throw new Error('Node has 0 height'); }) })),
    });

    const result: any = await screenshot.handler({ ...on, action: 'element', selector: '#empty' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('0 height');
  });

  it('reports a weasyprint pdf of a paused page as failed at once', async () => {
    const screenshot = makeScreenshot({ evaluate: vi.fn(() => new Promise(() => {})) }, { paused: true });

    const result: any = await Promise.race([
      screenshot.handler({ ...on, action: 'pdf', engine: 'weasyprint', saveToDisk: join(dir, 'paused.pdf') }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('still waiting after 500ms')), 500)),
    ]);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('paused');
  });

  it('keeps a chrome pdf made without saveToDisk, rather than discarding it', async () => {
    const detach = vi.fn(async () => {});
    const screenshot = makeScreenshot({
      createCDPSession: vi.fn(async () => ({
        send: vi.fn(async () => ({ data: Buffer.from('%PDF-1.7').toString('base64') })),
        detach,
      })),
    });

    const result: any = await screenshot.handler({ ...on, action: 'pdf' });

    const saved = result.content[0].text.match(/`([^`]+\.pdf)`/)?.[1];
    expect(result.isError).toBeFalsy();
    expect(saved && existsSync(saved)).toBe(true);
    expect(detach).toHaveBeenCalled();
  });

  it('saves a screenshot into a directory that does not exist yet', async () => {
    const screenshot = makeScreenshot({ screenshot: vi.fn(async () => Buffer.from('jpeg-bytes')) });
    const target = join(dir, 'new', 'nested', 'shot.jpg');

    const result: any = await screenshot.handler({ ...on, action: 'viewport', saveToDisk: target });

    expect(result.isError).toBeFalsy();
    expect(existsSync(target)).toBe(true);
  });
});
