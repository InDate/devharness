/**
 * What a page changes that never reaches the network: localStorage,
 * sessionStorage, cookies set by script, IndexedDB records, Cache Storage
 * entries, files in its origin-private file system, and the sockets and
 * workers it closes and starts.
 *
 * The proxy sees none of these, and an app whose state changes only here looks
 * like one that did nothing. Each is stamped on arrival with what was in
 * flight - a replay's run and step - so it sits under the same step as the
 * traffic beside it.
 *
 * What Chrome reports bounds what is held. DOMStorage events carry the key and
 * value. IndexedDB and Cache Storage report that a store or a cache changed and
 * not what changed, so the store is read and compared with its last reading;
 * the stamp is the event's, taken before the read. Cookies and the file system
 * have no change event at all, so they are compared on a timer and as each
 * step ends: a cookie or a file written and removed inside one comparison is
 * not seen.
 *
 * A logpoint's line is held beside them, keyed by its file and line with its
 * expressions' values as the value: it records what code ran under a step,
 * and a replay compares it with the recording as it compares a write.
 */

import type { CDPSession, Page, Target, WebWorker } from 'puppeteer-core';
import { currentCursor, onCursorEnd } from './proxy/registry.js';
import type { ProxyCursor } from './proxy/intercept-proxy.js';
import { describeStructuredValue } from './structured-value.js';
import { movesPerRun } from './bench/kinds.js';

export type WriteStore =
  | 'localStorage' | 'sessionStorage' | 'cookie' | 'indexedDB'
  | 'cacheStorage' | 'fileSystem' | 'socket' | 'worker' | 'logpoint';

export type WriteOperation = 'set' | 'changed' | 'removed' | 'cleared' | 'written' | 'started' | 'stopped' | 'closed' | 'logged';

export interface PageWrite {
  id: string;
  at: number;
  store: WriteStore;
  operation: WriteOperation;
  key?: string;
  /**
   * The key the write is counted under, where it differs from `key`: an
   * IndexedDB record keyed by an id or a counter is new on every run, so its
   * key in the store is replaced by `*` and the records are counted together.
   */
  group?: string;
  value?: string;
  cursor?: ProxyCursor;
}

const MAX_WRITES = 2000;
const VALUE_CHARS = 2000;
const COOKIE_POLL_MS = 500;
const FILE_POLL_MS = 1000;
/** Records read from one object store or cache; a store holding more is reported as written, not diffed. */
const RECORD_LIMIT = 200;
/** Entries walked in the file system before the walk stops. */
const FILE_LIMIT = 500;
/** How long service worker registrations reported on enabling are taken as already there. */
const REGISTRATIONS_SETTLE_MS = 500;

/** Operations that end something: each is a kind of its own, apart from the key being set. */
const ENDING: ReadonlySet<WriteOperation> = new Set(['removed', 'cleared', 'stopped', 'closed']);

/** What a write is listed and counted as: `localStorage:draft`, `localStorage:draft removed`. */
export function writeKey(write: Pick<PageWrite, 'store' | 'operation' | 'key' | 'group'>): string {
  const key = write.group ?? write.key;
  return `${write.store}:${[key, ENDING.has(write.operation) ? write.operation : undefined].filter(Boolean).join(' ')}`;
}

const SERIALIZE = `function () {
  var describe = (${describeStructuredValue.toString()});
  return JSON.stringify(describe(this, { maxTotalChars: ${VALUE_CHARS * 2} }));
}`;

async function call(client: CDPSession, method: string, params: any = {}, timeoutMs = 3000): Promise<any> {
  return Promise.race([
    client.send(method as any, params),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)),
  ]);
}

/** A URL on the page's own host as its path; a socket's `ws:` scheme is a different origin on the same host. */
function pathOf(url: string, origin?: string): string {
  try {
    const parsed = new URL(url);
    return origin && parsed.host === new URL(origin).host ? `${parsed.pathname}${parsed.search}` : url;
  } catch {
    return url;
  }
}

/** Old and new readings of one store, as the writes that turn the first into the second. */
function diff(
  before: Map<string, { sig: string; value?: string }>,
  after: Map<string, { sig: string; value?: string }>,
): Array<{ key: string; operation: WriteOperation; value?: string }> {
  const changes: Array<{ key: string; operation: WriteOperation; value?: string }> = [];
  for (const [key, now] of after) {
    const was = before.get(key);
    if (was?.sig === now.sig) continue;
    changes.push({ key, operation: was ? 'changed' : 'set', ...(now.value !== undefined ? { value: now.value } : {}) });
  }
  for (const key of before.keys()) if (!after.has(key)) changes.push({ key, operation: 'removed' });
  return changes;
}

type Reading = Map<string, { sig: string; value?: string }>;

export class WriteWatch {
  readonly writes: PageWrite[] = [];
  private count = 0;
  private cookies: Map<string, string> | undefined;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private trackedKey: string | undefined;
  private origin: string | undefined;
  /** Each IndexedDB object store's records at its last reading, by `database/store`. */
  private stores = new Map<string, Reading>();
  private databases = new Set<string>();
  /** Each cache's entries at its last reading. */
  private caches: Reading | undefined;
  private files: Reading | undefined;
  /** Timed reads of cookies and files, one at a time; `timedQueued` counts those waiting. */
  private timed: Promise<void> = Promise.resolve();
  private timedQueued = 0;
  /** Reads of IndexedDB and Cache Storage, one at a time, so each compares with the one before it. */
  private reads: Promise<void> = Promise.resolve();
  private sockets = new Map<string, string>();
  private registrations = new Map<string, string>();
  private registrationsSettled = false;
  private detach: Array<() => void> = [];

  constructor(private client: CDPSession, private page: Page) {}

  private push(write: Omit<PageWrite, 'id' | 'at' | 'cursor'>, at = Date.now(), cursor = currentCursor()): void {
    this.writes.push({
      id: `write-${++this.count}`,
      at,
      ...write,
      ...(write.value !== undefined ? { value: write.value.slice(0, VALUE_CHARS) } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (this.writes.length > MAX_WRITES) this.writes.splice(0, this.writes.length - MAX_WRITES);
  }

  /** Run a read after the ones queued before it, stamped with the moment it was asked for. */
  private queue(read: (at: number, cursor: ProxyCursor | undefined) => Promise<void>): void {
    const at = Date.now();
    const cursor = currentCursor();
    this.reads = this.reads.then(() => read(at, cursor)).catch(() => {});
  }

  async start(): Promise<void> {
    const area = (event: any): WriteStore => (event?.storageId?.isLocalStorage ? 'localStorage' : 'sessionStorage');
    this.client.on('DOMStorage.domStorageItemAdded' as any, (e: any) =>
      this.push({ store: area(e), operation: 'set', key: e.key, value: e.newValue }));
    this.client.on('DOMStorage.domStorageItemUpdated' as any, (e: any) =>
      this.push({ store: area(e), operation: 'changed', key: e.key, value: e.newValue }));
    this.client.on('DOMStorage.domStorageItemRemoved' as any, (e: any) =>
      this.push({ store: area(e), operation: 'removed', key: e.key }));
    this.client.on('DOMStorage.domStorageItemsCleared' as any, (e: any) =>
      this.push({ store: area(e), operation: 'cleared' }));
    await call(this.client, 'DOMStorage.enable').catch(() => {});

    await call(this.client, 'IndexedDB.enable').catch(() => {});
    this.client.on('Storage.indexedDBContentUpdated' as any, (e: any) => {
      if (e.storageKey === this.trackedKey) this.queue((at, cursor) => this.readStore(e.databaseName, e.objectStoreName, at, cursor));
    });
    this.client.on('Storage.indexedDBListUpdated' as any, (e: any) => {
      if (e.storageKey === this.trackedKey) this.queue((at, cursor) => this.readDatabases(at, cursor));
    });
    this.client.on('Storage.cacheStorageContentUpdated' as any, (e: any) => {
      if (e.storageKey === this.trackedKey) this.queue((at, cursor) => this.readCaches(at, cursor));
    });
    this.client.on('Storage.cacheStorageListUpdated' as any, (e: any) => {
      if (e.storageKey === this.trackedKey) this.queue((at, cursor) => this.readCaches(at, cursor));
    });
    await this.trackStorageKey();
    // Storage is tracked per storage key, so a navigation to another origin is tracked afresh.
    this.client.on('Page.frameNavigated' as any, (e: any) => {
      if (!e?.frame?.parentId) void this.trackStorageKey();
    });

    this.client.on('Network.webSocketCreated' as any, (e: any) => this.sockets.set(e.requestId, e.url));
    this.client.on('Network.webSocketClosed' as any, (e: any) => {
      const url = this.sockets.get(e.requestId);
      this.sockets.delete(e.requestId);
      if (url) this.push({ store: 'socket', operation: 'closed', key: pathOf(url, this.origin) });
    });
    await call(this.client, 'Network.enable').catch(() => {});

    // Runtime replays console calls made before it was enabled; those belong to no step of this watch.
    const watchedFrom = Date.now();
    this.client.on('Runtime.consoleAPICalled' as any, (e: any) => {
      if (typeof e?.timestamp === 'number' && e.timestamp < watchedFrom) return;
      const line = logpointLine(e?.args ?? []);
      if (line) this.push({ store: 'logpoint', operation: 'logged', key: line.key, value: line.value });
    });
    await call(this.client, 'Runtime.enable').catch(() => {});

    this.watchWorkers();
    this.client.on('ServiceWorker.workerRegistrationUpdated' as any, (e: any) => this.registrationsUpdated(e.registrations ?? []));
    await call(this.client, 'ServiceWorker.enable').catch(() => {});
    setTimeout(() => { this.registrationsSettled = true; }, REGISTRATIONS_SETTLE_MS);

    await this.readCookies(Date.now(), undefined);
    this.timers.push(setInterval(() => this.timedRead(() => this.readCookies(Date.now(), currentCursor())), COOKIE_POLL_MS));
    this.timers.push(setInterval(() => this.timedRead(() => this.readFiles(Date.now(), currentCursor())), FILE_POLL_MS));
    // A step ending reads both at once, so what it changed is stamped with it.
    this.detach.push(onCursorEnd((ending) => {
      const at = Date.now();
      this.timedRead(() => this.readCookies(at, ending), true);
      this.timedRead(() => this.readFiles(at, ending), true);
    }));
  }

  /** Queue a timed read; a timer's read is dropped while others wait, a step's never is. */
  private timedRead(read: () => Promise<void>, always = false): void {
    if (!always && this.timedQueued > 0) return;
    this.timedQueued += 1;
    this.timed = this.timed.then(read).catch(() => {}).finally(() => { this.timedQueued -= 1; });
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const off of this.detach) off();
    this.detach = [];
  }

  /** Writes that landed from `from` up to, not including, `to`. */
  between(from: number, to: number): PageWrite[] {
    return this.writes.filter(write => write.at >= from && write.at < to);
  }

  /**
   * Track the top frame's storage key, and read what it already holds, so the
   * first change after is compared with that rather than with nothing.
   */
  private async trackStorageKey(): Promise<void> {
    try {
      const { frameTree } = await call(this.client, 'Page.getFrameTree');
      const { storageKey } = await call(this.client, 'Storage.getStorageKeyForFrame', { frameId: frameTree.frame.id });
      if (!storageKey || storageKey === this.trackedKey) return;
      if (this.trackedKey) {
        await call(this.client, 'Storage.untrackIndexedDBForStorageKey', { storageKey: this.trackedKey }).catch(() => {});
        await call(this.client, 'Storage.untrackCacheStorageForStorageKey', { storageKey: this.trackedKey }).catch(() => {});
      }
      this.trackedKey = storageKey;
      this.origin = new URL(frameTree.frame.url).origin;
      this.stores.clear();
      this.databases.clear();
      this.caches = undefined;
      this.files = undefined;
      await call(this.client, 'Storage.trackIndexedDBForStorageKey', { storageKey });
      await call(this.client, 'Storage.trackCacheStorageForStorageKey', { storageKey }).catch(() => {});
      this.queue(() => this.readAll());
    } catch {
      // A page with no storage key - about:blank, a data URL - has no storage to watch.
    }
  }

  /** What IndexedDB and Cache Storage hold now, taken as the reading changes are compared with. */
  private async readAll(): Promise<void> {
    const key = this.trackedKey;
    const { databaseNames } = await call(this.client, 'IndexedDB.requestDatabaseNames', { storageKey: key })
      .catch(() => ({ databaseNames: [] }));
    for (const name of databaseNames as string[]) {
      this.databases.add(name);
      for (const store of await this.storeNames(name)) {
        const read = await this.recordsOf(name, store).catch(() => undefined);
        if (read && key === this.trackedKey) this.stores.set(`${name}/${store}`, read.records);
      }
    }
    this.caches = await this.cacheEntries().catch(() => undefined);
  }

  private async storeNames(database: string): Promise<string[]> {
    const { databaseWithObjectStores } = await call(this.client, 'IndexedDB.requestDatabase', {
      storageKey: this.trackedKey, databaseName: database,
    });
    return (databaseWithObjectStores?.objectStores ?? []).map((store: any) => store.name);
  }

  /** A remote value as JSON text, with structured-clone values described rather than dropped. */
  private async text(remote: any): Promise<string> {
    if (!remote?.objectId) {
      if ('value' in (remote ?? {})) return JSON.stringify(remote.value);
      return remote?.unserializableValue ?? remote?.description ?? '';
    }
    try {
      const { result } = await call(this.client, 'Runtime.callFunctionOn', {
        objectId: remote.objectId, functionDeclaration: SERIALIZE, returnByValue: true,
      });
      return typeof result?.value === 'string' ? result.value : remote.description ?? '';
    } catch {
      return remote.description ?? '';
    } finally {
      void call(this.client, 'Runtime.releaseObject', { objectId: remote.objectId }).catch(() => {});
    }
  }

  private async recordsOf(database: string, store: string): Promise<{ records: Reading; complete: boolean }> {
    const { objectStoreDataEntries: entries, hasMore } = await call(this.client, 'IndexedDB.requestData', {
      storageKey: this.trackedKey, databaseName: database, objectStoreName: store,
      skipCount: 0, pageSize: RECORD_LIMIT,
    });
    const records: Reading = new Map();
    for (const entry of entries ?? []) {
      const keyText = await this.text(entry.primaryKey);
      let key = keyText;
      try {
        const parsed = JSON.parse(keyText);
        if (typeof parsed === 'string') key = parsed;
      } catch { /* a described key stays as its JSON */ }
      const value = await this.text(entry.value);
      records.set(key, { sig: value, value });
    }
    return { records, complete: !hasMore };
  }

  private async readStore(database: string, store: string, at: number, cursor: ProxyCursor | undefined): Promise<void> {
    const id = `${database}/${store}`;
    const key = this.trackedKey;
    let read: { records: Reading; complete: boolean };
    try {
      read = await this.recordsOf(database, store);
    } catch {
      this.push({ store: 'indexedDB', operation: 'written', key: id }, at, cursor);
      return;
    }
    if (key !== this.trackedKey) return;
    // Past the limit a reading is one page of the store, and comparing pages
    // reports records that moved between them as removed and set.
    if (!read.complete) {
      this.stores.delete(id);
      this.push({ store: 'indexedDB', operation: 'written', key: id }, at, cursor);
      return;
    }
    const before = this.stores.get(id) ?? new Map();
    this.stores.set(id, read.records);
    for (const change of diff(before, read.records)) {
      this.push({
        store: 'indexedDB', operation: change.operation, key: `${id}/${change.key}`,
        ...(movesPerRun(change.key) ? { group: `${id}/*` } : {}),
        ...(change.value !== undefined ? { value: change.value } : {}),
      }, at, cursor);
    }
  }

  /** A database created or deleted; a deleted one takes its stores' readings with it. */
  private async readDatabases(at: number, cursor: ProxyCursor | undefined): Promise<void> {
    const { databaseNames } = await call(this.client, 'IndexedDB.requestDatabaseNames', { storageKey: this.trackedKey });
    const now = new Set(databaseNames as string[]);
    for (const name of now) if (!this.databases.has(name)) this.push({ store: 'indexedDB', operation: 'set', key: name }, at, cursor);
    for (const name of this.databases) {
      if (now.has(name)) continue;
      this.push({ store: 'indexedDB', operation: 'removed', key: name }, at, cursor);
      for (const id of [...this.stores.keys()]) if (id.startsWith(`${name}/`)) this.stores.delete(id);
    }
    this.databases = now;
  }

  /** Every cache's entries, keyed `cache url`, with the cache itself keyed by its name. */
  private async cacheEntries(): Promise<Reading> {
    const { caches } = await call(this.client, 'CacheStorage.requestCacheNames', { storageKey: this.trackedKey });
    const reading: Reading = new Map();
    for (const cache of caches ?? []) {
      reading.set(cache.cacheName, { sig: '' });
      const { cacheDataEntries } = await call(this.client, 'CacheStorage.requestEntries', {
        cacheId: cache.cacheId, skipCount: 0, pageSize: RECORD_LIMIT,
      });
      for (const entry of cacheDataEntries ?? []) {
        const value = JSON.stringify({ status: entry.responseStatus, type: entry.responseType });
        reading.set(`${cache.cacheName} ${pathOf(entry.requestURL, this.origin)}`, { sig: value, value });
      }
    }
    return reading;
  }

  private async readCaches(at: number, cursor: ProxyCursor | undefined): Promise<void> {
    const key = this.trackedKey;
    const now = await this.cacheEntries().catch(() => undefined);
    if (!now || key !== this.trackedKey) return;
    const before = this.caches ?? new Map();
    this.caches = now;
    for (const change of diff(before, now)) {
      // A deleted cache is one write, not one per entry it held.
      const cache = change.key.split(' ')[0];
      if (change.operation === 'removed' && change.key !== cache && !now.has(cache)) continue;
      this.push({ store: 'cacheStorage', operation: change.operation, key: change.key, ...(change.value !== undefined ? { value: change.value } : {}) }, at, cursor);
    }
  }

  /** The origin-private file system, walked from its root. */
  private async fileEntries(): Promise<Reading> {
    const reading: Reading = new Map();
    const walk = async (path: string[]): Promise<void> => {
      if (reading.size >= FILE_LIMIT) return;
      const { directory } = await call(this.client, 'FileSystem.getDirectory', {
        bucketFileSystemLocator: { storageKey: this.trackedKey, pathComponents: path },
      }, 1500);
      for (const file of directory?.nestedFiles ?? []) {
        const value = JSON.stringify({ size: file.size, type: file.type });
        reading.set(`/${[...path, file.name].join('/')}`, { sig: `${file.size}|${file.lastModified}`, value });
      }
      for (const name of directory?.nestedDirectories ?? []) {
        reading.set(`/${[...path, name].join('/')}/`, { sig: '' });
        await walk([...path, name]);
      }
    };
    await walk([]);
    return reading;
  }

  private async readFiles(at: number, cursor: ProxyCursor | undefined): Promise<void> {
    if (!this.trackedKey) return;
    const key = this.trackedKey;
    // A bucket with no file system yet answers with an error; it holds nothing.
    const now = await this.fileEntries().catch(() => new Map() as Reading);
    if (key !== this.trackedKey) return;
    const before = this.files;
    this.files = now;
    // The first reading is what was already there, not something written.
    if (!before) return;
    for (const change of diff(before, now)) {
      this.push({ store: 'fileSystem', operation: change.operation, key: change.key, ...(change.value !== undefined ? { value: change.value } : {}) }, at, cursor);
    }
  }

  /**
   * Dedicated and shared workers starting and stopping. A service worker's own
   * start and stop are left out: Chrome starts one for a fetch and stops it
   * once idle, on a schedule no step sets. Its registration is watched instead.
   */
  private watchWorkers(): void {
    const started = (worker: WebWorker) => this.push({ store: 'worker', operation: 'started', key: pathOf(worker.url(), this.origin) });
    const stopped = (worker: WebWorker) => this.push({ store: 'worker', operation: 'stopped', key: pathOf(worker.url(), this.origin) });
    this.page.on('workercreated', started);
    this.page.on('workerdestroyed', stopped);
    this.detach.push(() => { this.page.off('workercreated', started); this.page.off('workerdestroyed', stopped); });

    const browser = this.page.browser();
    const shared = (target: Target) => target.type() === 'shared_worker' && new URL(target.url()).origin === this.origin;
    const created = (target: Target) => {
      if (shared(target)) this.push({ store: 'worker', operation: 'started', key: `shared ${pathOf(target.url(), this.origin)}` });
    };
    const destroyed = (target: Target) => {
      if (shared(target)) this.push({ store: 'worker', operation: 'stopped', key: `shared ${pathOf(target.url(), this.origin)}` });
    };
    browser.on('targetcreated', created);
    browser.on('targetdestroyed', destroyed);
    this.detach.push(() => { browser.off('targetcreated', created); browser.off('targetdestroyed', destroyed); });
  }

  /** Service worker registrations for this origin; those reported on enabling were already there. */
  private registrationsUpdated(registrations: Array<{ registrationId: string; scopeURL: string; isDeleted: boolean }>): void {
    for (const registration of registrations) {
      let origin: string | undefined;
      try { origin = new URL(registration.scopeURL).origin; } catch { continue; }
      if (origin !== this.origin) continue;
      const key = `service ${pathOf(registration.scopeURL, this.origin)}`;
      const known = this.registrations.has(registration.registrationId);
      if (registration.isDeleted) {
        if (!known) continue;
        this.registrations.delete(registration.registrationId);
        this.push({ store: 'worker', operation: 'removed', key });
      } else if (!known) {
        this.registrations.set(registration.registrationId, key);
        if (this.registrationsSettled) this.push({ store: 'worker', operation: 'set', key });
      }
    }
  }

  private async readCookies(at: number, cursor: ProxyCursor | undefined): Promise<void> {
    const url = this.page.url();
    if (!/^https?:/.test(url)) return;
    let found: Array<{ name: string; value: string; domain: string; path: string }>;
    try {
      ({ cookies: found } = await call(this.client, 'Network.getCookies', { urls: [url] }, 1500));
    } catch {
      return;
    }
    const now = new Map(found.map(c => [`${c.name}; ${c.domain}${c.path}`, `${c.name}=${c.value}`]));
    const before = this.cookies;
    this.cookies = now;
    // The first read is what was already there, not something written.
    if (!before) return;
    for (const [id, pair] of now) {
      const was = before.get(id);
      if (was === pair) continue;
      const [name, ...rest] = pair.split('=');
      this.push({ store: 'cookie', operation: was === undefined ? 'set' : 'changed', key: name, value: rest.join('=') }, at, cursor);
    }
    for (const [id, pair] of before) {
      if (!now.has(id)) this.push({ store: 'cookie', operation: 'removed', key: pair.split('=')[0] }, at, cursor);
    }
  }
}

/** One write in a line: `localStorage set draft = {"body":…}`. */
/**
 * A logpoint's console call as a key and a value: the file's path and line,
 * without the query a dev server adds on each rebuild, and the JSON of its
 * expressions' values, or its message where it logged no values.
 */
export function logpointLine(args: Array<{ value?: unknown }>): { key: string; value: string } | undefined {
  const head = args[0]?.value;
  if (typeof head !== 'string') return undefined;
  const at = head.match(/^\[Logpoint\]\s+(.+?):(\d+)(?::(?:auto|\d+))?:$/);
  if (!at) return undefined;
  let path = at[1];
  try {
    path = new URL(at[1]).pathname;
  } catch {
    path = at[1].split('?')[0];
  }
  const fields = args[2]?.value;
  const message = args[1]?.value;
  const value = typeof fields === 'string' ? fields : typeof message === 'string' ? message : '';
  return { key: `${path}:${at[2]}`, value };
}

export function writeLine(write: PageWrite): string {
  const value = write.value !== undefined ? ` = ${write.value.slice(0, 80)}` : '';
  return `${write.store} ${write.operation}${write.key ? ` ${write.key}` : ''}${value}`;
}
