/**
 * Tests for the socket a CLI process calls tools through.
 *
 * The round-trip cases bind a real socket in a temp DEVHARNESS_DIR and connect
 * to it, because the things worth asserting - that a ToolError comes back as a
 * renderable response, that a half-written request does not reply early - are
 * properties of the framing, not of a mocked handler.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { connect } from 'net';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initializePaths } from './helpers/paths.js';
import {
  startSessionEndpoint,
  listSessionRecords,
  getEndpointsDir,
  getEndpointAddress,
  getPresencePath,
  type SessionEndpoint,
  type EndpointReply,
} from './session-endpoint.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

let dir: string;
let previousDir: string | undefined;
let endpoint: SessionEndpoint | null = null;

beforeEach(() => {
  previousDir = process.env.DEVHARNESS_DIR;
  dir = mkdtempSync(join(tmpdir(), 'devharness-endpoint-'));
  process.env.DEVHARNESS_DIR = dir;
  initializePaths();
});

afterEach(async () => {
  if (endpoint) {
    await endpoint.close();
    endpoint = null;
  }
  if (previousDir === undefined) delete process.env.DEVHARNESS_DIR;
  else process.env.DEVHARNESS_DIR = previousDir;
  initializePaths();
  rmSync(dir, { recursive: true, force: true });
});

/** One request over the socket, resolving with the parsed reply. */
function callEndpoint(address: string, payload: unknown): Promise<EndpointReply> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const socket = connect(address);
    socket.setEncoding('utf-8');
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as EndpointReply);
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}

const IDENTITY = { pid: process.pid, ppid: process.ppid, cwd: '/repo' };

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

describe('getEndpointAddress', () => {
  posixOnly('puts the socket beside the presence record', () => {
    expect(getEndpointAddress(1234)).toBe(join(getEndpointsDir(), '1234.sock'));
    expect(getPresencePath(1234)).toBe(join(getEndpointsDir(), '1234.json'));
  });

  posixOnly('falls back to the temp directory when the path would exceed the sockaddr limit', () => {
    process.env.DEVHARNESS_DIR = join(dir, 'x'.repeat(120));
    initializePaths();
    const address = getEndpointAddress(1234);
    expect(address).not.toContain('x'.repeat(120));
    expect(address).toContain('session-1234.sock');
  });
});

// ---------------------------------------------------------------------------
// round trip
// ---------------------------------------------------------------------------

describe('endpoint round trip', () => {
  posixOnly('runs the named tool and returns its response', async () => {
    const calls: Array<{ tool: string; args: unknown }> = [];
    endpoint = await startSessionEndpoint({
      executeToolCall: async (tool, args) => {
        calls.push({ tool, args });
        return { content: [{ type: 'text', text: 'ran it' }], _meta: { tool } };
      },
      identity: IDENTITY,
    });

    const reply = await callEndpoint(endpoint!.address, { tool: 'config', args: { action: 'status' } });

    expect(reply.ok).toBe(true);
    expect((reply.response as any).content[0].text).toBe('ran it');
    expect(calls).toEqual([{ tool: 'config', args: { action: 'status' } }]);
  });

  posixOnly('returns a ToolError\'s response, so an error renders like any other result', async () => {
    const failure = { content: [{ type: 'text', text: 'nope' }], isError: true, _errorId: 'SOME_ERROR' };
    endpoint = await startSessionEndpoint({
      executeToolCall: async () => { throw Object.assign(new Error('nope'), { response: failure }); },
      identity: IDENTITY,
    });

    const reply = await callEndpoint(endpoint!.address, { tool: 'whatever', args: {} });

    expect(reply.ok).toBe(true);
    expect(reply.response).toEqual(failure);
  });

  posixOnly('reports a throw that carries no response as a failed call', async () => {
    endpoint = await startSessionEndpoint({
      executeToolCall: async () => { throw new Error('Unknown tool: nope'); },
      identity: IDENTITY,
    });

    const reply = await callEndpoint(endpoint!.address, { tool: 'nope', args: {} });

    expect(reply.ok).toBe(false);
    expect(reply.error).toBe('Unknown tool: nope');
  });

  posixOnly('rejects a request that is not JSON', async () => {
    endpoint = await startSessionEndpoint({ executeToolCall: async () => ({}), identity: IDENTITY });
    const reply = await new Promise<EndpointReply>((resolve, reject) => {
      let buffer = '';
      const socket = connect(endpoint!.address);
      socket.setEncoding('utf-8');
      socket.on('connect', () => socket.write('not json\n'));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        socket.destroy();
        resolve(JSON.parse(buffer.split('\n')[0]) as EndpointReply);
      });
      socket.on('error', reject);
    });

    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/single line of JSON/);
  });

  posixOnly('rejects a request with no tool name', async () => {
    endpoint = await startSessionEndpoint({ executeToolCall: async () => ({}), identity: IDENTITY });
    const reply = await callEndpoint(endpoint!.address, { args: {} });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/tool name/);
  });

  posixOnly('binds over a socket file left by a process that was killed', async () => {
    mkdirSync(getEndpointsDir(), { recursive: true });
    writeFileSync(getEndpointAddress(process.pid), '');

    endpoint = await startSessionEndpoint({ executeToolCall: async () => ({ content: [] }), identity: IDENTITY });
    expect(endpoint).not.toBeNull();

    const reply = await callEndpoint(endpoint!.address, { tool: 'x', args: {} });
    expect(reply.ok).toBe(true);
  });

  posixOnly('gives the socket and the record owner-only permissions', async () => {
    endpoint = await startSessionEndpoint({ executeToolCall: async () => ({ content: [] }), identity: IDENTITY });
    expect(statSync(endpoint!.address).mode & 0o777).toBe(0o600);
    expect(statSync(endpoint!.presencePath).mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// presence records
// ---------------------------------------------------------------------------

describe('presence records', () => {
  posixOnly('publishes this session and picks it up again', async () => {
    endpoint = await startSessionEndpoint({ executeToolCall: async () => ({}), identity: IDENTITY });

    const records = listSessionRecords();
    expect(records).toHaveLength(1);
    expect(records[0].pid).toBe(process.pid);
    expect(records[0].address).toBe(endpoint!.address);
    expect(records[0].shortId).toBeUndefined();
  });

  posixOnly('carries the ids once refresh supplies them', async () => {
    endpoint = await startSessionEndpoint({ executeToolCall: async () => ({}), identity: IDENTITY });
    await endpoint!.refresh({ sessionId: 'full-uuid', shortId: 'abcd1234' });

    expect(listSessionRecords()[0].shortId).toBe('abcd1234');
    expect(listSessionRecords()[0].sessionId).toBe('full-uuid');
  });

  posixOnly('drops a record whose process is gone, and its socket with it', async () => {
    mkdirSync(getEndpointsDir(), { recursive: true });
    const deadPid = 2;  // pid 2 is not a devharness session on any machine this runs on
    const deadSocket = join(getEndpointsDir(), '999999.sock');
    writeFileSync(deadSocket, '');
    writeFileSync(join(getEndpointsDir(), '999999.json'), JSON.stringify({
      pid: 999999, ppid: deadPid, cwd: '/gone', address: deadSocket, startedAt: 1,
    }));

    expect(listSessionRecords()).toEqual([]);
    expect(existsSync(join(getEndpointsDir(), '999999.json'))).toBe(false);
    expect(existsSync(deadSocket)).toBe(false);
  });

  posixOnly('ignores a file that is not one of ours', async () => {
    mkdirSync(getEndpointsDir(), { recursive: true });
    // The shape server-claims.ts writes - no address, so nothing to dial.
    writeFileSync(join(getEndpointsDir(), '4242.json'), JSON.stringify({
      supervisorPid: 4242, cwd: '/repo', childPid: 4243,
    }));

    expect(listSessionRecords()).toEqual([]);
    expect(existsSync(join(getEndpointsDir(), '4242.json'))).toBe(true);
  });

  posixOnly('orders sessions started in the same ms by pid, whatever order the files are read in', async () => {
    const pids = [process.pid, process.ppid].sort((a, b) => a - b);
    // Each arrangement puts the pids under the other file name, so one of the two lists against readdir's order.
    for (const names of [['a', 'b'], ['b', 'a']]) {
      rmSync(getEndpointsDir(), { recursive: true, force: true });
      mkdirSync(getEndpointsDir(), { recursive: true });
      pids.forEach((pid, i) => writeFileSync(join(getEndpointsDir(), `${names[i]}.json`), JSON.stringify({
        pid, ppid: 1, cwd: '/repo', address: join(getEndpointsDir(), `${pid}.sock`), startedAt: 5,
      })));

      expect(listSessionRecords().map(record => record.pid)).toEqual(pids);
    }
  });

  posixOnly('removes the record and the socket on close', async () => {
    endpoint = await startSessionEndpoint({ executeToolCall: async () => ({}), identity: IDENTITY });
    const { address, presencePath } = endpoint!;

    await endpoint!.close();
    endpoint = null;

    expect(existsSync(address)).toBe(false);
    expect(existsSync(presencePath)).toBe(false);
  });
});
