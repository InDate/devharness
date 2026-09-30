import { describe, it, expect } from 'vitest';
import { translateCall, translateSequence, replacementFor, callTarget, unknownToolResponse } from './legacy-steps.js';

describe('translateCall', () => {
  it('turns a launchChrome reference into a connection launch name, keeping the other parameters', () => {
    expect(translateCall('launchChrome', { reference: 'app', url: 'http://a/', port: 9333, proxy: true }))
      .toEqual({ tool: 'connection', params: { action: 'launch', name: 'app', url: 'http://a/', port: 9333, proxy: true } });
  });

  it('turns calls that address a connection into connectionReason', () => {
    expect(translateCall('disconnectDebugger', { reference: 'app', reason: 'done' }))
      .toEqual({ tool: 'connection', params: { action: 'close', connectionReason: 'app', reason: 'done' } });
    expect(translateCall('getDebuggerStatus', { reference: 'app' }))
      .toEqual({ tool: 'connection', params: { action: 'status', connectionReason: 'app' } });
  });

  it('moves kill and resetLauncher to browser', () => {
    expect(translateCall('killChrome', { reason: 'r', port: 9222 }))
      .toEqual({ tool: 'browser', params: { action: 'kill', reason: 'r', port: 9222 } });
    expect(translateCall('resetChromeLauncher', { reason: 'r' }))
      .toEqual({ tool: 'browser', params: { action: 'resetLauncher', reason: 'r' } });
  });

  it('maps each tab action onto connection', () => {
    expect(translateCall('tab', { action: 'create', reference: 'b', url: 'http://b/' }))
      .toEqual({ tool: 'connection', params: { action: 'launch', name: 'b', url: 'http://b/' } });
    expect(translateCall('tab', { action: 'rename', reference: 'a', newReference: 'b' }))
      .toEqual({ tool: 'connection', params: { action: 'rename', connectionReason: 'a', name: 'b' } });
    expect(translateCall('tab', { action: 'close', reference: 'a' }).params)
      .toMatchObject({ action: 'close', connectionReason: 'a', reason: expect.any(String) });
    expect(translateCall('tab', { action: 'list' }))
      .toEqual({ tool: 'connection', params: { action: 'list' } });
  });

  it('turns single-operation tools into actions of source, modal, download and config', () => {
    expect(translateCall('getSourceCode', { url: 'app.js', startLine: 3 }))
      .toEqual({ tool: 'source', params: { action: 'get', url: 'app.js', startLine: 3 } });
    expect(translateCall('loadSourceMaps', { directory: 'dist' }))
      .toEqual({ tool: 'source', params: { action: 'loadMaps', directory: 'dist' } });
    expect(translateCall('detectModals', { connectionReason: 'app' }))
      .toEqual({ tool: 'modal', params: { action: 'detect', connectionReason: 'app' } });
    expect(translateCall('dismissModal', { connectionReason: 'app', index: 1 }))
      .toEqual({ tool: 'modal', params: { action: 'dismiss', connectionReason: 'app', index: 1 } });
    expect(translateCall('saveToDisk', { url: 'http://a/f.txt', filename: 'f.txt' }))
      .toEqual({ tool: 'download', params: { url: 'http://a/f.txt', filename: 'f.txt' } });
    expect(translateCall('setDebugLogging', { enabled: true }))
      .toEqual({ tool: 'config', params: { action: 'setDebugLogging', enabled: true } });
    expect(translateCall('getDebugLoggingStatus', {}))
      .toEqual({ tool: 'config', params: { action: 'debugLoggingStatus' } });
  });

  it('carries into a tab action only the keys its connection action accepts', () => {
    const stray = { reference: 'a', newReference: 'b', url: 'http://a/', bringToFront: true };
    expect(translateCall('tab', { action: 'list', ...stray }))
      .toEqual({ tool: 'connection', params: { action: 'list' } });
    expect(translateCall('tab', { action: 'switch', ...stray }))
      .toEqual({ tool: 'connection', params: { action: 'switch', connectionReason: 'a', bringToFront: true } });
    expect(translateCall('tab', { action: 'close', ...stray }).params)
      .toEqual({ action: 'close', connectionReason: 'a', reason: expect.any(String) });
    expect(translateCall('tab', { action: 'rename', ...stray }))
      .toEqual({ tool: 'connection', params: { action: 'rename', connectionReason: 'a', name: 'b' } });
    expect(translateCall('tab', { action: 'create', ...stray }))
      .toEqual({ tool: 'connection', params: { action: 'launch', name: 'a', url: 'http://a/', bringToFront: true } });
  });

  it('leaves a call to a tool that still exists unchanged', () => {
    const params = { action: 'goto', url: 'http://a/', connectionReason: 'app' };
    expect(translateCall('navigate', params)).toEqual({ tool: 'navigate', params });
  });
});

describe('translateSequence', () => {
  it('rewrites steps and teardown and keeps every other field', () => {
    const sequence = {
      id: 's', name: 'n', createdAt: 1,
      commands: [
        { tool: 'launchChrome', params: { reference: 'app' }, note: 'kept' },
        { tool: 'navigate', params: { action: 'goto', url: 'http://a/' } },
      ],
      teardown: [{ tool: 'killChrome', params: { reason: 'end' } }],
    };

    expect(translateSequence(sequence)).toEqual({
      id: 's', name: 'n', createdAt: 1,
      commands: [
        { tool: 'connection', params: { action: 'launch', name: 'app' }, note: 'kept' },
        { tool: 'navigate', params: { action: 'goto', url: 'http://a/' } },
      ],
      teardown: [{ tool: 'browser', params: { action: 'kill', reason: 'end' } }],
    });
  });
});

describe('replacementFor', () => {
  it('names the replacement of a removed tool, and nothing for a current one', () => {
    expect(replacementFor('launchChrome')).toContain("action: 'launch'");
    expect(replacementFor('connection')).toBeUndefined();
  });
});

describe('callTarget', () => {
  const tools = { connection: 'connection-tool', navigate: 'navigate-tool' };

  it('reaches the tool that replaced an old name, with the parameters translated', () => {
    expect(callTarget(tools, 'launchChrome', { reference: 'shop' })).toEqual({
      toolName: 'connection', params: { action: 'launch', name: 'shop' }, tool: 'connection-tool',
    });
  });

  it('reaches no tool for a name that is neither current nor replaced, nor an inherited property', () => {
    expect(callTarget(tools, 'nosuchtool', {}).tool).toBeUndefined();
    expect(callTarget(tools, 'toString', {}).tool).toBeUndefined();
  });
});

describe('unknownToolResponse', () => {
  it('names what replaced an old tool, and lists the tools there are', () => {
    const response = unknownToolResponse('killChrome', ['navigate', 'browser']);
    const body = JSON.parse(response.content[0].text);

    expect(response.isError).toBe(true);
    expect(body).toMatchObject({ code: 'UNKNOWN_TOOL', availableTools: ['browser', 'navigate'] });
    expect(body.replacedBy).toContain("browser with action: 'kill'");
  });

  it('names no replacement for a name that never existed', () => {
    const body = JSON.parse(unknownToolResponse('nosuchtool', []).content[0].text);
    expect(body).not.toHaveProperty('replacedBy');
  });
});

describe('a name matching an inherited object property', () => {
  it('is no removed tool: the call, the step and the replacement are left as they are', () => {
    expect(translateCall('toString', { a: 1 })).toEqual({ tool: 'toString', params: { a: 1 } });
    expect(translateCall('constructor', {})).toEqual({ tool: 'constructor', params: {} });
    expect(replacementFor('constructor')).toBeUndefined();
    expect(translateSequence({ commands: [{ tool: 'hasOwnProperty', params: {} }] }).commands)
      .toEqual([{ tool: 'hasOwnProperty', params: {} }]);
  });
});
