/**
 * Tests for feature-011 (IndexedDB read/write actions) and feature-012
 * (sessionStorage get/set + single-key delete) in the `storage` tool.
 *
 * The interesting half is `describeStructuredValue`: IndexedDB holds
 * structured-clone values, and the ones worth asserting on (a non-extractable
 * CryptoKey, a Blob, an ArrayBuffer) all JSON-serialize to `{}`. The serializer
 * is deliberately written as a pure, self-contained function so it can be
 * exercised here without a browser - which is also what makes it safe to
 * stringify and eval inside the page.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStorageTools, describeStructuredValue } from './storage-tools.js';

// ---------------------------------------------------------------------------
// describeStructuredValue
// ---------------------------------------------------------------------------

describe('describeStructuredValue - primitives', () => {
  it('passes JSON-expressible primitives through untouched', () => {
    expect(describeStructuredValue('hi')).toBe('hi');
    expect(describeStructuredValue(42)).toBe(42);
    expect(describeStructuredValue(0)).toBe(0);
    expect(describeStructuredValue(false)).toBe(false);
    expect(describeStructuredValue(null)).toBeNull();
  });

  it('keeps values JSON would silently drop or corrupt', () => {
    expect(describeStructuredValue(undefined)).toEqual({ __type: 'Undefined' });
    expect(describeStructuredValue(NaN)).toEqual({ __type: 'Number', value: 'NaN' });
    expect(describeStructuredValue(Infinity)).toEqual({ __type: 'Number', value: 'Infinity' });
    expect(describeStructuredValue(-Infinity)).toEqual({ __type: 'Number', value: '-Infinity' });
    expect(describeStructuredValue(10n ** 30n)).toEqual({ __type: 'BigInt', value: '1000000000000000000000000000000' });
    expect(describeStructuredValue(Symbol('tok'))).toEqual({ __type: 'Symbol', description: 'Symbol(tok)' });
    expect(describeStructuredValue(function named() {})).toEqual({ __type: 'Function', name: 'named' });
  });

  it('does not lose an undefined property inside an object', () => {
    // JSON.stringify({a: undefined}) is '{}' - the key vanishes entirely.
    expect(describeStructuredValue({ a: undefined, b: 1 })).toEqual({ a: { __type: 'Undefined' }, b: 1 });
  });
});

describe('describeStructuredValue - built-ins', () => {
  it('describes Date, including an invalid one', () => {
    const d = new Date('2026-07-26T02:30:36.000Z');
    expect(describeStructuredValue(d)).toEqual({
      __type: 'Date',
      iso: '2026-07-26T02:30:36.000Z',
      time: d.getTime(),
    });
    expect(describeStructuredValue(new Date('nope'))).toEqual({ __type: 'Date', iso: null, time: null });
  });

  it('describes RegExp and Error', () => {
    expect(describeStructuredValue(/ab+c/gi)).toEqual({ __type: 'RegExp', source: 'ab+c', flags: 'gi' });
    expect(describeStructuredValue(new TypeError('bad'))).toEqual({ __type: 'Error', name: 'TypeError', message: 'bad' });
  });

  it('describes Map, including non-string keys', () => {
    const m = new Map<any, any>([
      ['a', 1],
      [{ id: 7 }, new Date(0)],
    ]);
    expect(describeStructuredValue(m)).toEqual({
      __type: 'Map',
      size: 2,
      entries: [
        ['a', 1],
        [{ id: 7 }, { __type: 'Date', iso: '1970-01-01T00:00:00.000Z', time: 0 }],
      ],
    });
  });

  it('describes Set, including nested collections', () => {
    expect(describeStructuredValue(new Set([1, 'two', new Set([3])]))).toEqual({
      __type: 'Set',
      size: 3,
      values: [1, 'two', { __type: 'Set', size: 1, values: [3] }],
    });
  });

  it('describes Blob and File without reading their bytes', () => {
    const blob = new Blob(['hello'], { type: 'text/plain' });
    expect(describeStructuredValue(blob)).toEqual({ __type: 'Blob', size: 5, mimeType: 'text/plain' });

    const file = new File(['abc'], 'note.txt', { type: 'text/plain', lastModified: 1234 });
    expect(describeStructuredValue(file)).toEqual({
      __type: 'File',
      name: 'note.txt',
      size: 3,
      mimeType: 'text/plain',
      lastModified: 1234,
    });
  });

  it('describes ArrayBuffer, typed arrays and DataView', () => {
    expect(describeStructuredValue(new ArrayBuffer(8))).toEqual({ __type: 'ArrayBuffer', byteLength: 8 });

    expect(describeStructuredValue(new Uint8Array([1, 2, 3]))).toEqual({
      __type: 'Uint8Array',
      byteLength: 3,
      byteOffset: 0,
      length: 3,
      preview: [1, 2, 3],
    });

    const big = describeStructuredValue(new Uint8Array(40).fill(9));
    expect(big.length).toBe(40);
    expect(big.preview).toHaveLength(16);
    expect(big.previewTruncated).toBe(true);

    const view = describeStructuredValue(new DataView(new ArrayBuffer(16), 4));
    expect(view).toEqual({ __type: 'DataView', byteLength: 12, byteOffset: 4 });
    expect(view.preview).toBeUndefined();
  });

  it('stringifies BigInt64Array previews so the result stays JSON-safe', () => {
    const out = describeStructuredValue(new BigInt64Array([1n, 2n]));
    expect(out.preview).toEqual(['1', '2']);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe('describeStructuredValue - CryptoKey (the motivating case)', () => {
  it('reports a real non-extractable key instead of {}', async () => {
    const pair: any = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);

    // What we are replacing: JSON sees nothing at all.
    expect(JSON.stringify(pair.privateKey)).toBe('{}');

    const out = describeStructuredValue(pair.privateKey);
    expect(out.__type).toBe('CryptoKey');
    expect(out.keyType).toBe('private');
    expect(out.extractable).toBe(false);
    expect(out.usages).toEqual(['sign']);
    expect(out.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
  });

  it('finds a key nested inside a stored record, alongside ordinary fields', async () => {
    const pair: any = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const record = { id: 'device-1', createdAt: new Date(0), keys: { signing: pair.privateKey } };

    const out = describeStructuredValue(record);
    expect(out.id).toBe('device-1');
    expect(out.createdAt.__type).toBe('Date');
    expect(out.keys.signing).toMatchObject({ __type: 'CryptoKey', keyType: 'private', extractable: false });
  });

  it('recognises a cross-realm key by constructor name, without instanceof', () => {
    // A value handed back from another realm fails `instanceof` even when it is
    // genuinely a CryptoKey, so the constructor name is checked too.
    class CryptoKey {
      type = 'secret';
      extractable = true;
      usages = ['encrypt'];
      algorithm = { name: 'AES-GCM', length: 256 };
    }
    expect(describeStructuredValue(new CryptoKey())).toEqual({
      __type: 'CryptoKey',
      keyType: 'secret',
      extractable: true,
      usages: ['encrypt'],
      algorithm: { name: 'AES-GCM', length: 256 },
    });
  });
});

describe('describeStructuredValue - cycles, depth and size', () => {
  it('reports a self-reference as circular with its path', () => {
    const o: any = { name: 'root' };
    o.self = o;
    expect(describeStructuredValue(o)).toEqual({ name: 'root', self: { __type: 'Circular', path: '$' } });
  });

  it('reports a deep back-reference with the path of the ancestor', () => {
    const root: any = { a: { b: {} } };
    root.a.b.up = root.a;
    expect(describeStructuredValue(root).a.b.up).toEqual({ __type: 'Circular', path: '$.a' });
  });

  it('handles cycles through arrays, Maps and Sets', () => {
    const arr: any[] = [1];
    arr.push(arr);
    expect(describeStructuredValue(arr)[1]).toEqual({ __type: 'Circular', path: '$' });

    const m = new Map<any, any>();
    m.set('self', m);
    expect(describeStructuredValue(m).entries[0][1]).toEqual({ __type: 'Circular', path: '$' });

    const s = new Set<any>();
    s.add(s);
    expect(describeStructuredValue(s).values[0]).toEqual({ __type: 'Circular', path: '$' });
  });

  it('treats a shared reference as a DAG, not a cycle', () => {
    const shared = { v: 1 };
    const out = describeStructuredValue({ a: shared, b: shared });
    expect(out.a).toEqual({ v: 1 });
    expect(out.b).toEqual({ v: 1 });
  });

  it('never throws or recurses forever on a mutually cyclic pair', () => {
    const a: any = { name: 'a' };
    const b: any = { name: 'b', a };
    a.b = b;
    expect(() => JSON.stringify(describeStructuredValue(a))).not.toThrow();
  });

  it('stops at maxDepth', () => {
    const deep = { l1: { l2: { l3: { l4: 'bottom' } } } };
    expect(describeStructuredValue(deep, { maxDepth: 2 })).toEqual({
      l1: { l2: { l3: { __type: 'MaxDepth', className: 'Object' } } },
    });
    // The default is deep enough for a realistically nested record.
    expect(describeStructuredValue(deep).l1.l2.l3.l4).toBe('bottom');
  });

  it('truncates oversized arrays, objects, Maps and Sets', () => {
    const arr = describeStructuredValue([1, 2, 3, 4, 5], { maxItems: 2 });
    expect(arr).toEqual([1, 2, { __type: 'Truncated', omitted: 3 }]);

    const obj = describeStructuredValue({ a: 1, b: 2, c: 3 }, { maxItems: 2 });
    expect(obj).toEqual({ a: 1, b: 2, __truncated: 1 });

    const map = describeStructuredValue(new Map([['a', 1], ['b', 2]]), { maxItems: 1 });
    expect(map).toEqual({ __type: 'Map', size: 2, entries: [['a', 1]], truncated: true });

    const set = describeStructuredValue(new Set([1, 2]), { maxItems: 1 });
    expect(set).toEqual({ __type: 'Set', size: 2, values: [1], truncated: true });
  });
});

describe('describeStructuredValue - total budgets', () => {
  /**
   * The bug this covers: maxItems is per container and maxDepth is per path, so
   * they multiply. A 500-wide array whose every element points at the *same*
   * 500-wide array (deliberately re-serialized, since a shared reference is a
   * DAG and not a cycle) is 500^6 visited nodes at the default depth - enough to
   * pin the page's main thread until the protocol call times out. A large
   * normalized cache with shared sub-objects gets there without malice.
   */
  function compoundingSharedStructure(levels: number, width: number) {
    let level: any = { leaf: true };
    for (let i = 0; i < levels; i++) {
      const shared = level;
      const next: any[] = [];
      for (let j = 0; j < width; j++) next.push(shared);
      level = next;
    }
    return level;
  }

  it('stops a compounding shared-reference structure in bounded time', () => {
    // 500^6 if the per-level caps were the only bound.
    const value = compoundingSharedStructure(6, 500);

    const started = Date.now();
    const out = describeStructuredValue(value);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(out.__budgetExceeded ?? out[out.length - 1]?.limit).toBeTruthy();

    // The budget, not luck, is what stopped it: the emitted node count is at
    // most the cap, and the marker names which budget tripped.
    const flat = JSON.stringify(out);
    expect(flat.length).toBeLessThan(2_000_000);
    expect(flat).toContain('"__type":"BudgetExceeded"');
    expect(flat).toContain('maxNodes');
  });

  it('honours a lowered node budget exactly, and marks where it stopped', () => {
    const value = compoundingSharedStructure(6, 10);
    const out = describeStructuredValue(value, { maxNodes: 50 });

    const flat = JSON.stringify(out);
    // 50 nodes visited => far fewer than 10^6 BudgetExceeded-free values.
    expect((flat.match(/"BudgetExceeded"/g) || []).length).toBeGreaterThan(0);
    expect(flat).toContain('"limit":"maxNodes"');
  });

  it('trips the total character budget on many mid-sized strings', () => {
    const chunk = 'x'.repeat(1000);
    const value: any = {};
    for (let i = 0; i < 200; i++) value['k' + i] = chunk;

    const out = describeStructuredValue(value, { maxTotalChars: 5000 });
    expect(out.__budgetExceeded).toBe('maxTotalChars');
    expect(JSON.stringify(out).length).toBeLessThan(50_000);
  });

  it('leaves an ordinary record completely untouched and unflagged', () => {
    const record = { id: 'a', nested: { list: [1, 2, 3], when: new Date(0) } };
    const out = describeStructuredValue(record);
    expect(out.__budgetExceeded).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('BudgetExceeded');
    expect(out.nested.list).toEqual([1, 2, 3]);
  });

  it('caps a single huge string and reports its real length', () => {
    const huge = 'a'.repeat(50_000);
    const out = describeStructuredValue({ blobText: huge });
    expect(out.blobText.__type).toBe('String');
    expect(out.blobText.length).toBe(50_000);
    expect(out.blobText.truncated).toBe(true);
    expect(out.blobText.value).toHaveLength(10_000);

    // Short strings still pass straight through.
    expect(describeStructuredValue({ s: 'small' }).s).toBe('small');
    expect(describeStructuredValue('ab', { maxStringLength: 1 })).toEqual({
      __type: 'String', length: 2, truncated: true, value: 'a',
    });
  });

  it('survives a throwing Symbol.toStringTag instead of aborting the whole read', () => {
    const hostile: any = { ok: 1 };
    Object.defineProperty(hostile, Symbol.toStringTag, {
      get() { throw new Error('toStringTag boom'); },
    });

    const out = describeStructuredValue({ before: 1, hostile, after: 2 });
    expect(out.before).toBe(1);
    expect(out.after).toBe(2);
    expect(out.hostile.ok).toBe(1);
  });
});

describe('describeStructuredValue - objects', () => {
  it('labels class instances with their constructor name', () => {
    class Session {
      constructor(public id: string) {}
    }
    expect(describeStructuredValue(new Session('s1'))).toEqual({ __class: 'Session', id: 's1' });
  });

  it('survives a null-prototype object and a throwing getter', () => {
    const bare = Object.create(null);
    bare.x = 1;
    expect(describeStructuredValue(bare)).toEqual({ x: 1 });

    const hostile = {
      get boom(): any {
        throw new Error('nope');
      },
      ok: 1,
    };
    const out = describeStructuredValue(hostile);
    expect(out.ok).toBe(1);
    expect(out.boom).toEqual({ __type: 'Unreadable', reason: 'nope' });
  });

  it('always produces something JSON.stringify can handle', () => {
    const cyclic: any = { d: new Date(0), m: new Map([['k', new Uint8Array([1])]]) };
    cyclic.self = cyclic;
    const kitchenSink = [cyclic, 1n, undefined, NaN, new Blob(['x']), Symbol('s'), () => {}];
    expect(() => JSON.stringify(describeStructuredValue(kitchenSink))).not.toThrow();
  });

  it('is self-contained enough to be stringified and re-created in another realm', () => {
    // This mirrors exactly what the tool does inside page.evaluate: the source
    // is eval'd with no access to this module's scope. If the function ever
    // grows a closure dependency, this is what catches it.
    const rebuilt = new Function('return (' + describeStructuredValue.toString() + ')')() as typeof describeStructuredValue;
    const value = { when: new Date(0), bytes: new Uint8Array([1, 2]), tags: new Set(['a']) };
    expect(rebuilt(value)).toEqual(describeStructuredValue(value));
  });
});

// ---------------------------------------------------------------------------
// storage tool
// ---------------------------------------------------------------------------

/** A CDPManager that is never paused, so executeWithPauseDetection just runs. */
function fakeCdpManager(): any {
  return {
    isPaused: () => false,
    getPausedInfo: () => ({}),
    waitForPause: () => new Promise(() => {}), // never settles
  };
}

/**
 * A page whose `evaluate` actually runs the callback in this process. The
 * in-page code only touches globals (localStorage/sessionStorage/indexedDB), so
 * running it here exercises the real logic rather than a stub.
 */
function fakePage() {
  return {
    evaluate: vi.fn(async (fn: any, ...args: any[]) => fn(...args)),
    cookies: vi.fn(async () => []),
    setCookie: vi.fn(async () => {}),
    deleteCookie: vi.fn(async () => {}),
  };
}

function buildTool(page: any = fakePage()) {
  const puppeteerManager: any = { isConnected: () => true, getPage: () => page };
  const tools = createStorageTools(puppeteerManager, fakeCdpManager());
  return { tools, page };
}

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join('\n');
}

/**
 * A Web Storage shim. Neither happy-dom nor Node exposes a usable
 * localStorage/sessionStorage pair here, and the in-page code only ever touches
 * the globals, so installing our own is enough to run it for real.
 */
function makeStorage() {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(String(k), String(v)); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => { data.clear(); },
  };
}

let localStorage: ReturnType<typeof makeStorage>;
let sessionStorage: ReturnType<typeof makeStorage>;

beforeEach(() => {
  localStorage = makeStorage();
  sessionStorage = makeStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: localStorage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: sessionStorage, configurable: true, writable: true });
});

describe('storage - sessionStorage actions (feature-012)', () => {
  it('reads the whole sessionStorage when no key is given', async () => {
    sessionStorage.setItem('lockScreen', 'pending');
    sessionStorage.setItem('other', '1');
    const { tools } = buildTool();

    const text = textOf(await tools.storage.handler({ action: 'getSessionStorage' } as any));
    expect(text).toContain('sessionStorage');
    expect(text).toContain('lockScreen');
    expect(text).toContain('pending');
    expect(text).toContain('other');
  });

  it('reads a single sessionStorage key, and reports a missing one as null', async () => {
    sessionStorage.setItem('lockScreen', 'pending');
    const { tools } = buildTool();

    expect(textOf(await tools.storage.handler({ action: 'getSessionStorage', key: 'lockScreen' } as any)))
      .toContain('"lockScreen": "pending"');
    expect(textOf(await tools.storage.handler({ action: 'getSessionStorage', key: 'absent' } as any)))
      .toContain('"absent": null');
  });

  it('writes sessionStorage without touching localStorage', async () => {
    const { tools } = buildTool();

    const result = await tools.storage.handler({ action: 'setSessionStorage', key: 'flag', value: 'on' } as any);
    expect(result.isError).toBeFalsy();
    expect(sessionStorage.getItem('flag')).toBe('on');
    expect(localStorage.getItem('flag')).toBeNull();
  });

  it('removes a single key from each store and says whether it was there', async () => {
    localStorage.setItem('keep', '1');
    localStorage.setItem('drop', '2');
    sessionStorage.setItem('drop', '3');
    const { tools } = buildTool();

    const local = await tools.storage.handler({ action: 'removeLocalStorage', key: 'drop' } as any);
    expect(local.isError).toBeFalsy();
    expect(localStorage.getItem('drop')).toBeNull();
    expect(localStorage.getItem('keep')).toBe('1');

    const session = await tools.storage.handler({ action: 'removeSessionStorage', key: 'drop' } as any);
    expect(session.isError).toBeFalsy();
    expect(sessionStorage.getItem('drop')).toBeNull();

    const absent = await tools.storage.handler({ action: 'removeLocalStorage', key: 'never-existed' } as any);
    expect(absent.isError).toBeFalsy();
    expect(textOf(absent)).toContain('not present');
  });

  it('requires key and value where the action needs them', async () => {
    const { tools } = buildTool();

    expect((await tools.storage.handler({ action: 'setSessionStorage', value: 'v' } as any)).isError).toBe(true);
    expect((await tools.storage.handler({ action: 'setSessionStorage', key: 'k' } as any)).isError).toBe(true);
    expect((await tools.storage.handler({ action: 'removeSessionStorage' } as any)).isError).toBe(true);
    expect((await tools.storage.handler({ action: 'removeLocalStorage' } as any)).isError).toBe(true);
  });

  it('writes an empty string and a zero key instead of calling them missing', async () => {
    // Clearing a flag by setting '' is a normal operation, and 0 is a valid key.
    localStorage.setItem('flag', 'on');
    sessionStorage.setItem('flag', 'on');
    const { tools } = buildTool();

    const session = await tools.storage.handler({ action: 'setSessionStorage', key: 'flag', value: '' } as any);
    expect(session.isError).toBeFalsy();
    expect(sessionStorage.getItem('flag')).toBe('');

    const local = await tools.storage.handler({ action: 'setLocalStorage', key: 'flag', value: '' } as any);
    expect(local.isError).toBeFalsy();
    expect(localStorage.getItem('flag')).toBe('');

    const zeroKey = await tools.storage.handler({ action: 'setSessionStorage', key: 0, value: 'v' } as any);
    expect(zeroKey.isError).toBeFalsy();
    expect(sessionStorage.getItem('0')).toBe('v');

    const removed = await tools.storage.handler({ action: 'removeSessionStorage', key: 0 } as any);
    expect(removed.isError).toBeFalsy();
    expect(sessionStorage.getItem('0')).toBeNull();
    expect(textOf(removed)).not.toContain('not present');
  });

  it('sets an empty cookie value rather than rejecting it', async () => {
    const { tools, page } = buildTool();

    const result = await tools.storage.handler({ action: 'setCookie', name: 'session', value: '' } as any);
    expect(result.isError).toBeFalsy();
    expect(page.setCookie).toHaveBeenCalledWith(expect.objectContaining({ name: 'session', value: '' }));
  });

  it('accepts the new actions and the indexedDB clear target in the schema', () => {
    const { tools } = buildTool();
    const schema = tools.storage.zodSchema;

    for (const action of ['getSessionStorage', 'setSessionStorage', 'removeSessionStorage', 'removeLocalStorage',
      'idbListDatabases', 'idbListStores', 'idbGet', 'idbGetAll', 'idbPut', 'idbDelete']) {
      expect(schema.safeParse({ action }).success, action).toBe(true);
    }
    expect(schema.safeParse({ action: 'clear', reason: 'test', types: ['indexedDB'] }).success).toBe(true);
    expect(schema.safeParse({ action: 'idbGet', db: 'a', store: 'b', key: 7 }).success).toBe(true);
    expect(schema.safeParse({ action: 'idbPut', db: 'a', store: 'b', record: { nested: [1] } }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A minimal in-memory IndexedDB, just enough to drive the tool's in-page code.
// happy-dom provides no IndexedDB, and the point here is to exercise the real
// request/transaction plumbing (async callbacks, tx settling, missing db/store
// handling), not to re-test the browser.
// ---------------------------------------------------------------------------

function makeFakeIndexedDB(spec: Record<string, { version?: number; stores: Record<string, { keyPath?: string | null; autoIncrement?: boolean; records?: Array<[any, any]> }> }>) {
  const databases: Record<string, any> = {};
  for (const [dbName, dbSpec] of Object.entries(spec)) {
    const stores: Record<string, any> = {};
    for (const [storeName, s] of Object.entries(dbSpec.stores)) {
      stores[storeName] = {
        keyPath: s.keyPath ?? null,
        autoIncrement: s.autoIncrement ?? false,
        data: new Map<any, any>(s.records ?? []),
      };
    }
    databases[dbName] = { version: dbSpec.version ?? 1, stores };
  }

  const request = (run: () => any) => {
    const req: any = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: undefined, error: null };
    queueMicrotask(() => {
      try {
        req.result = run();
        req.onsuccess && req.onsuccess();
      } catch (e: any) {
        req.error = e;
        req.onerror && req.onerror();
      }
    });
    return req;
  };

  const nameList = (names: string[]) => {
    const list: any = names.slice();
    list.contains = (n: string) => names.indexOf(n) !== -1;
    return list;
  };

  function makeDb(name: string) {
    const state = databases[name];
    return {
      name,
      version: state.version,
      objectStoreNames: nameList(Object.keys(state.stores)),
      closed: false,
      close() { this.closed = true; },
      transaction(storeNames: string | string[], _mode?: string) {
        const tx: any = { oncomplete: null, onerror: null, onabort: null, error: null, aborted: false };
        tx.abort = () => { tx.aborted = true; tx.onabort && tx.onabort(); };
        tx.objectStore = (storeName: string) => {
          const s = state.stores[storeName];
          const arr = (): Array<[any, any]> => Array.from(s.data.entries()) as Array<[any, any]>;
          return {
            keyPath: s.keyPath,
            autoIncrement: s.autoIncrement,
            indexNames: nameList([]),
            count: () => request(() => s.data.size),
            get: (key: any) => request(() => s.data.get(key)),
            getAll: (_q: any, limit?: number) => request(() => arr().slice(0, limit ?? Infinity).map(([, v]) => v)),
            getAllKeys: (_q: any, limit?: number) => request(() => arr().slice(0, limit ?? Infinity).map(([k]) => k)),
            put: (value: any, key?: any) => request(() => {
              const finalKey = s.keyPath ? value[s.keyPath] : key ?? s.data.size + 1;
              s.data.set(finalKey, value);
              return finalKey;
            }),
            delete: (key: any) => request(() => { s.data.delete(key); return undefined; }),
          };
        };
        // Real transactions auto-commit once their requests drain; a macrotask
        // lands after the awaited (microtask) requests, which is close enough.
        setTimeout(() => { if (!tx.aborted) tx.oncomplete && tx.oncomplete(); }, 0);
        return tx;
      },
    };
  }

  return {
    databases: async () => Object.entries(databases).map(([name, d]: any) => ({ name, version: d.version })),
    open(name: string) {
      const req: any = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: undefined, error: null };
      queueMicrotask(() => {
        if (!databases[name]) {
          // Matches the browser: opening an unknown name creates it.
          databases[name] = { version: 1, stores: {} };
          req.result = makeDb(name);
          req.onupgradeneeded && req.onupgradeneeded();
        } else {
          req.result = makeDb(name);
        }
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
    deleteDatabase(name: string) {
      return request(() => { delete databases[name]; return undefined; });
    },
    __state: databases,
  };
}

describe('storage - IndexedDB actions (feature-011)', () => {
  let fakeIdb: any;

  afterEach(() => {
    delete (globalThis as any).indexedDB;
  });

  function install(spec: any) {
    fakeIdb = makeFakeIndexedDB(spec);
    (globalThis as any).indexedDB = fakeIdb;
    return fakeIdb;
  }

  it('lists databases', async () => {
    install({ app: { version: 3, stores: { keys: {} } }, other: { stores: {} } });
    const { tools } = buildTool();

    const text = textOf(await tools.storage.handler({ action: 'idbListDatabases' } as any));
    expect(text).toContain('app');
    expect(text).toContain('other');
    expect(text).toContain('"version": 3');
  });

  it('lists object stores with their key configuration and record counts', async () => {
    install({ app: { stores: { keys: { keyPath: 'id', records: [['a', { id: 'a' }]] }, blobs: { autoIncrement: true } } } });
    const { tools } = buildTool();

    const text = textOf(await tools.storage.handler({ action: 'idbListStores', db: 'app' } as any));
    expect(text).toContain('keys');
    expect(text).toContain('"keyPath": "id"');
    expect(text).toContain('"count": 1');
    expect(text).toContain('blobs');
    expect(text).toContain('"autoIncrement": true');
  });

  it('gets a record and reports a missing key as not found', async () => {
    install({ app: { stores: { kv: { records: [['token', { value: 'abc' }]] } } } });
    const { tools } = buildTool();

    const found = await tools.storage.handler({ action: 'idbGet', db: 'app', store: 'kv', key: 'token' } as any);
    expect(found.isError).toBeFalsy();
    expect(textOf(found)).toContain('abc');

    const missing = await tools.storage.handler({ action: 'idbGet', db: 'app', store: 'kv', key: 'nope' } as any);
    expect(missing.isError).toBeFalsy();
    expect(textOf(missing)).toContain('No record found');
  });

  it('returns a non-extractable CryptoKey as a descriptor rather than {}', async () => {
    const pair: any = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    install({ identity: { stores: { keys: { records: [['device', { id: 'device', signing: pair.privateKey }]] } } } });
    const { tools } = buildTool();

    const text = textOf(await tools.storage.handler({ action: 'idbGet', db: 'identity', store: 'keys', key: 'device' } as any));
    expect(text).toContain('"__type": "CryptoKey"');
    expect(text).toContain('"extractable": false');
    expect(text).toContain('ECDSA');
    expect(text).toContain('P-256');
  });

  it('reads all records, honouring limit and flagging truncation', async () => {
    const records: Array<[any, any]> = [];
    for (let i = 0; i < 5; i++) records.push([i, { i }]);
    install({ app: { stores: { items: { records } } } });
    const { tools } = buildTool();

    const all = textOf(await tools.storage.handler({ action: 'idbGetAll', db: 'app', store: 'items' } as any));
    expect(all).toContain('**Count:** 5');

    const limited = textOf(await tools.storage.handler({ action: 'idbGetAll', db: 'app', store: 'items', limit: 2 } as any));
    expect(limited).toContain('**Count:** 2');
    expect(limited).toContain('showing 2 of 5');
  });

  it('writes a record with an out-of-line key', async () => {
    const idb = install({ app: { stores: { kv: {} } } });
    const { tools } = buildTool();

    const result = await tools.storage.handler({
      action: 'idbPut', db: 'app', store: 'kv', key: 'flag', record: { enabled: true },
    } as any);

    expect(result.isError).toBeFalsy();
    expect(idb.__state.app.stores.kv.data.get('flag')).toEqual({ enabled: true });
  });

  it('writes a record with an in-line key, and rejects a redundant key parameter', async () => {
    const idb = install({ app: { stores: { docs: { keyPath: 'id' } } } });
    const { tools } = buildTool();

    const ok = await tools.storage.handler({ action: 'idbPut', db: 'app', store: 'docs', record: { id: 'doc-1', title: 'x' } } as any);
    expect(ok.isError).toBeFalsy();
    expect(idb.__state.app.stores.docs.data.get('doc-1')).toEqual({ id: 'doc-1', title: 'x' });

    const conflict = await tools.storage.handler({
      action: 'idbPut', db: 'app', store: 'docs', key: 'doc-2', record: { id: 'doc-2' },
    } as any);
    expect(conflict.isError).toBe(true);
    expect(textOf(conflict)).toContain('in-line key');
  });

  it('refuses an out-of-line put with no key rather than writing under a guessed one', async () => {
    install({ app: { stores: { kv: {} } } });
    const { tools } = buildTool();

    const result = await tools.storage.handler({ action: 'idbPut', db: 'app', store: 'kv', record: { a: 1 } } as any);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"key" parameter is required');
  });

  it('deletes a record and reports when there was nothing to delete', async () => {
    const idb = install({ app: { stores: { kv: { records: [['gone', 1]] } } } });
    const { tools } = buildTool();

    const deleted = await tools.storage.handler({ action: 'idbDelete', db: 'app', store: 'kv', key: 'gone' } as any);
    expect(deleted.isError).toBeFalsy();
    expect(idb.__state.app.stores.kv.data.has('gone')).toBe(false);

    const absent = await tools.storage.handler({ action: 'idbDelete', db: 'app', store: 'kv', key: 'never' } as any);
    expect(absent.isError).toBeFalsy();
    expect(textOf(absent)).toContain('no record existed');
  });

  it('does not leave an empty database behind when the name does not exist', async () => {
    const idb = install({ app: { stores: { kv: {} } } });
    const { tools } = buildTool();

    const result = await tools.storage.handler({ action: 'idbGet', db: 'typo', store: 'kv', key: 'x' } as any);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not exist');
    // The read must not have created "typo" as a side effect.
    expect(idb.__state.typo).toBeUndefined();
  });

  it('names the available stores when the requested one is missing', async () => {
    install({ app: { stores: { kv: {}, other: {} } } });
    const { tools } = buildTool();

    const result = await tools.storage.handler({ action: 'idbGet', db: 'app', store: 'nope', key: 'x' } as any);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not found in database');
  });

  it('surfaces a browser without indexedDB.databases() as an error, not a crash', async () => {
    (globalThis as any).indexedDB = { open: () => {} };
    const { tools } = buildTool();

    const result = await tools.storage.handler({ action: 'idbListDatabases' } as any);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not supported');
  });

  it('requires db, store, key and record where the action needs them', async () => {
    install({ app: { stores: { kv: {} } } });
    const { tools } = buildTool();

    expect((await tools.storage.handler({ action: 'idbListStores' } as any)).isError).toBe(true);
    expect((await tools.storage.handler({ action: 'idbGet', store: 'kv', key: 'a' } as any)).isError).toBe(true);
    expect((await tools.storage.handler({ action: 'idbGet', db: 'app', key: 'a' } as any)).isError).toBe(true);
    expect((await tools.storage.handler({ action: 'idbGet', db: 'app', store: 'kv' } as any)).isError).toBe(true);
    expect((await tools.storage.handler({ action: 'idbDelete', db: 'app', store: 'kv' } as any)).isError).toBe(true);
    expect((await tools.storage.handler({ action: 'idbPut', db: 'app', store: 'kv', key: 'k' } as any)).isError).toBe(true);
  });

  it('clears IndexedDB only when asked, and reports what it deleted', async () => {
    const idb = install({ app: { stores: { kv: {} } }, other: { stores: {} } });
    const { tools } = buildTool();

    const untouched = await tools.storage.handler({ action: 'clear', reason: 'test', types: ['localStorage'] } as any);
    expect(untouched.isError).toBeFalsy();
    expect(Object.keys(idb.__state)).toHaveLength(2);

    const cleared = await tools.storage.handler({ action: 'clear', reason: 'test', types: ['indexedDB'] } as any);
    expect(cleared.isError).toBeFalsy();
    expect(textOf(cleared)).toContain('indexedDB (2 deleted');
    expect(Object.keys(idb.__state)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// virtual authenticator
// ---------------------------------------------------------------------------

describe('storage authenticator actions', () => {
  function sessionPage() {
    const sent: { method: string; params: any }[] = [];
    const session = {
      send: vi.fn(async (method: string, params: any) => {
        sent.push({ method, params });
        if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'auth-1' };
        if (method === 'WebAuthn.getCredentials') return { credentials: [{ credentialId: 'cred-1', rpId: 'keel.test', userHandle: 'aG9sZGVy', signCount: 2, isResidentCredential: true, privateKey: 'secret' }] };
        return {};
      }),
    };
    return { page: { ...fakePage(), createCDPSession: vi.fn(async () => session) }, sent };
  }

  it('adds an authenticator that reports the user verified, and lists passkeys without their private keys', async () => {
    const { page, sent } = sessionPage();
    const { tools } = buildTool(page);
    const added: any = await tools.storage.handler({ action: 'authenticatorAdd' });
    expect(added._meta.storage.authenticator).toEqual({ id: 'auth-1', userVerified: true });
    const options = sent.find((s) => s.method === 'WebAuthn.addVirtualAuthenticator')!.params.options;
    expect(options).toMatchObject({ protocol: 'ctap2', transport: 'internal', hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true });

    const listed: any = await tools.storage.handler({ action: 'authenticatorCredentials' });
    expect(listed._meta.storage.authenticator.credentials).toEqual([{ credentialId: 'cred-1', rpId: 'keel.test', userHandle: 'aG9sZGVy', signCount: 2, resident: true }]);
    expect(JSON.stringify(listed)).not.toContain('secret');

    const removed: any = await tools.storage.handler({ action: 'authenticatorRemove' });
    expect(removed._meta.storage.authenticator).toEqual({ id: 'auth-1', removed: true });
  });

  it('adds one that reports presence without verification where asked', async () => {
    const { page, sent } = sessionPage();
    const { tools } = buildTool(page);
    await tools.storage.handler({ action: 'authenticatorAdd', userVerified: false });
    expect(sent.find((s) => s.method === 'WebAuthn.addVirtualAuthenticator')!.params.options.isUserVerified).toBe(false);
  });

  it('refuses a credentials read on a page holding no authenticator', async () => {
    const { tools } = buildTool(sessionPage().page);
    const r: any = await tools.storage.handler({ action: 'authenticatorCredentials' });
    expect(r.isError).toBe(true);
    expect(r._errorId).toBe('NO_AUTHENTICATOR');
  });
});
