/**
 * These tools all accept a `connectionReason` in their schema. That parameter
 * is only honest if the work actually happens on the resolved connection - a
 * handler that resolves the connection and then quietly operates on the
 * default/active managers is the same "accepted but ignored parameter" bug as
 * a param nothing reads at all.
 *
 * Each test below routes to a *non-default* connection and asserts the effect
 * landed there, not on the default managers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInspectionTools } from './inspection-tools.js';
import { createNetworkTools } from './network-tools.js';
import { createModalTools } from './modal-tools.js';
import { validateParams } from '../validation-helpers.js';

// ---------------------------------------------------------------------------
// inspect: searchCode / searchFunctions
// ---------------------------------------------------------------------------

function makeFakeCdpManager(label: string) {
  return {
    isConnected: vi.fn(() => true),
    getAllScripts: vi.fn(() => [{ scriptId: `${label}-script`, url: `http://${label}.test/app.js` }]),
    searchInScript: vi.fn(async () => [
      { lineNumber: 0, lineContent: `const marker = '${label}';` },
    ]),
    getScriptLine: vi.fn(async () => null),
  } as any;
}

const fakeSourceMapHandler = {
  mapToOriginal: vi.fn(async () => null),
} as any;

describe('inspect searchCode/searchFunctions honour connectionReason', () => {
  let defaultCdp: any;
  let otherCdp: any;
  let inspect: any;

  beforeEach(() => {
    defaultCdp = makeFakeCdpManager('default');
    otherCdp = makeFakeCdpManager('other');
    const tools = createInspectionTools(fakeSourceMapHandler, async (reason: string) =>
      reason === 'other-tab'
        ? { connection: {}, cdpManager: otherCdp, puppeteerManager: null, consoleMonitor: null, networkMonitor: null }
        : null
    );
    inspect = tools.inspect;
  });

  it('searchCode searches the scripts of the referenced connection, not the default one', async () => {
    const result = await inspect.handler({
      action: 'searchCode',
      connectionReason: 'other-tab',
      pattern: 'marker',
    });

    const text = result.content.map((c: any) => c.text).join('\n');
    expect(text).toContain('other.test/app.js');
    expect(text).toContain("const marker = 'other';");
    expect(text).not.toContain('default.test/app.js');

    expect(otherCdp.searchInScript).toHaveBeenCalled();
    expect(defaultCdp.searchInScript).not.toHaveBeenCalled();
    expect(defaultCdp.getAllScripts).not.toHaveBeenCalled();
  });

  it('searchCode reports NOT connected based on the referenced connection', async () => {
    otherCdp.isConnected.mockReturnValue(false);
    // Only the named connection is read, and it reports not connected.
    const result = await inspect.handler({
      action: 'searchCode',
      connectionReason: 'other-tab',
      pattern: 'marker',
    });

    expect(result.isError).toBe(true);
    expect(result.content.map((c: any) => c.text).join('\n')).toMatch(/not connected/i);
  });

  it('searchFunctions searches the scripts of the referenced connection', async () => {
    const result = await inspect.handler({
      action: 'searchFunctions',
      connectionReason: 'other-tab',
      functionName: 'marker',
    });

    const text = result.content.map((c: any) => c.text).join('\n');
    expect(text).toContain('other.test/app.js');
    expect(otherCdp.searchInScript).toHaveBeenCalled();
    expect(defaultCdp.searchInScript).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// network: enable / disable
// ---------------------------------------------------------------------------

function makeFakePuppeteerManager(label: string) {
  const page = { __label: label };
  return {
    isConnected: vi.fn(() => true),
    getPage: vi.fn(() => page),
    __page: page,
  } as any;
}

function makeFakeNetworkMonitor() {
  return {
    isActive: vi.fn(() => false),
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    getRequests: vi.fn(() => []),
    getRequest: vi.fn(() => undefined),
    getCount: vi.fn(() => 0),
    getSockets: vi.fn(() => []),
    getStreams: vi.fn(() => []),
  } as any;
}

describe('network enable/disable honour connectionReason', () => {
  let defaultPuppeteer: any;
  let defaultMonitor: any;
  let otherPuppeteer: any;
  let otherMonitor: any;
  let network: any;

  beforeEach(() => {
    defaultPuppeteer = makeFakePuppeteerManager('default');
    defaultMonitor = makeFakeNetworkMonitor();
    otherPuppeteer = makeFakePuppeteerManager('other');
    otherMonitor = makeFakeNetworkMonitor();

    const tools = createNetworkTools(async (reason: string) =>
      reason === 'other-tab'
        ? { connection: {}, cdpManager: {}, puppeteerManager: otherPuppeteer, consoleMonitor: null, networkMonitor: otherMonitor }
        : reason === 'node-target'
          ? { connection: {}, cdpManager: {}, puppeteerManager: null, consoleMonitor: null, networkMonitor: null }
          : null
    );
    network = tools.network;
  });

  it('enable starts monitoring on the referenced connection only', async () => {
    const result = await network.handler({ action: 'enable', connectionReason: 'other-tab' });

    expect(result.isError).toBeFalsy();
    expect(otherMonitor.startMonitoring).toHaveBeenCalledWith(otherPuppeteer.__page);
    expect(defaultMonitor.startMonitoring).not.toHaveBeenCalled();
  });

  it('disable stops monitoring on the referenced connection only', async () => {
    const result = await network.handler({ action: 'disable', connectionReason: 'other-tab' });

    expect(result.isError).toBeFalsy();
    expect(otherMonitor.stopMonitoring).toHaveBeenCalledWith(otherPuppeteer.__page);
    expect(defaultMonitor.stopMonitoring).not.toHaveBeenCalled();
  });

  it('enable errors when the reference does not resolve', async () => {
    const result = await network.handler({ action: 'enable', connectionReason: 'nope' });

    expect(result.isError).toBe(true);
    expect(defaultMonitor.startMonitoring).not.toHaveBeenCalled();
    expect(otherMonitor.startMonitoring).not.toHaveBeenCalled();
  });

  it.each(['list', 'get', 'search', 'enable', 'disable', 'setConditions', 'sockets', 'streams'])(
    '%s without a reference fails validation naming connectionReason',
    (action) => {
      const result = validateParams({ action }, network.zodSchema, 'network');

      expect(result.success).toBe(false);
      expect((result as any).error.missingParameters.map((p: any) => p.name)).toContain('connectionReason');
    }
  );

  it.each([
    { action: 'list' },
    { action: 'search', pattern: '.' },
    { action: 'sockets' },
    { action: 'streams' },
    { action: 'setConditions', preset: 'offline' },
  ])('$action on a connection with no page refuses rather than reading the default connection', async (args) => {
    const result = await network.handler({ ...args, connectionReason: 'node-target' });

    expect(result.isError).toBe(true);
    expect(defaultPuppeteer.getPage).not.toHaveBeenCalled();
    expect(defaultMonitor.getRequests).not.toHaveBeenCalled();
    expect(defaultMonitor.getSockets).not.toHaveBeenCalled();
    expect(defaultMonitor.getStreams).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// modal dismiss: resolves its page from the connection
// ---------------------------------------------------------------------------

vi.mock('../utils/modal-detector.js', async () => {
  return {
    detectModals: vi.fn(async () => [
      {
        selector: '#cookie-banner',
        type: 'cookie-consent',
        zIndex: 9999,
        boundingBox: { x: 0, y: 0, width: 800, height: 600 },
        dismissStrategies: ['accept', 'close', 'remove'],
        confidence: 90,
        description: 'Cookie consent banner',
      },
    ]),
  };
});

vi.mock('../utils/modal-dismissal.js', async () => {
  return {
    selectDismissalStrategy: vi.fn(() => 'accept'),
    dismissModalByStrategy: vi.fn(async () => ({ success: true, method: 'click' })),
  };
});

const { detectModals: mockedDetectModals } = await import('../utils/modal-detector.js');
const { dismissModalByStrategy: mockedDismiss } = await import('../utils/modal-dismissal.js');

describe('modal dismiss resolves its page from the connection', () => {
  const cdpManager = {
    isPaused: () => false,
    getPausedInfo: () => ({}),
    waitForPause: () => new Promise(() => {}),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dismisses using the resolved connection page (previously undefined)', async () => {
    const puppeteerManager = makeFakePuppeteerManager('other');
    const tools = createModalTools(async (reason: string) =>
      reason === 'other-tab'
        ? { connection: {}, cdpManager, puppeteerManager, consoleMonitor: null, networkMonitor: null }
        : null
    );

    const result = await tools.modal.handler({
      action: 'dismiss',
      connectionReason: 'other-tab',
      strategy: 'accept',
      retryAttempts: 3,
    });

    const text = result.content.map((c: any) => c.text).join('\n');
    expect(result.isError).toBeFalsy();
    expect(text).toContain('Cookie consent banner');

    // The page handed to detection/dismissal must be the connection's page.
    expect(mockedDetectModals).toHaveBeenCalledWith(puppeteerManager.__page, expect.anything());
    expect(mockedDismiss).toHaveBeenCalledWith(
      puppeteerManager.__page,
      expect.objectContaining({ selector: '#cookie-banner' }),
      'accept',
      3
    );
  });

  it('returns a connection error rather than throwing when the reference is unknown', async () => {
    const tools = createModalTools(async () => null);

    const result = await tools.modal.handler({
      action: 'dismiss',
      connectionReason: 'nope',
      strategy: 'auto',
      retryAttempts: 3,
    });

    expect(result.isError).toBe(true);
    expect(result.content.map((c: any) => c.text).join('\n')).toMatch(/connection_not_found|No Chrome browser/i);
    expect(mockedDetectModals).not.toHaveBeenCalled();
  });
});
