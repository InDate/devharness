import { describe, it, expect } from 'vitest';
import { translateCall, translateSequence, replacementFor } from './legacy-steps.js';

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
