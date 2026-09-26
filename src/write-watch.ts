/**
 * Writes a page makes that never reach the network: localStorage,
 * sessionStorage, cookies set by script, and IndexedDB.
 *
 * The proxy sees none of these, and an app whose state changes only here looks
 * like one that did nothing. Each is stamped on arrival with what was in
 * flight - a replay's run and step - so it sits under the same step as the
 * traffic beside it.
 *
 * What Chrome reports bounds what is held. DOMStorage events carry the key and
 * value. IndexedDB reports that an object store changed and not what changed.
 * Cookies have no change event at all, so they are compared twice a second: a
 * cookie set and cleared inside one comparison is not seen.
 */

import type { CDPSession, Page } from 'puppeteer-core';
import { currentCursor } from './proxy/registry.js';
import type { ProxyCursor } from './proxy/intercept-proxy.js';

export type WriteStore = 'localStorage' | 'sessionStorage' | 'cookie' | 'indexedDB';

export interface PageWrite {
  id: string;
  at: number;
  store: WriteStore;
  operation: 'set' | 'changed' | 'removed' | 'cleared' | 'written';
  key?: string;
  value?: string;
  cursor?: ProxyCursor;
}

const MAX_WRITES = 2000;
const VALUE_CHARS = 2000;
const COOKIE_POLL_MS = 500;

async function call(client: CDPSession, method: string, params: any = {}, timeoutMs = 3000): Promise<any> {
  return Promise.race([
    client.send(method as any, params),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs)),
  ]);
}

export class WriteWatch {
  readonly writes: PageWrite[] = [];
  private count = 0;
  private cookies: Map<string, string> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private trackedKey: string | undefined;

  constructor(private client: CDPSession, private page: Page) {}

  private push(write: Omit<PageWrite, 'id' | 'at' | 'cursor'>): void {
    const cursor = currentCursor();
    this.writes.push({
      id: `write-${++this.count}`,
      at: Date.now(),
      ...write,
      ...(write.value !== undefined ? { value: write.value.slice(0, VALUE_CHARS) } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (this.writes.length > MAX_WRITES) this.writes.splice(0, this.writes.length - MAX_WRITES);
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

    this.client.on('Storage.indexedDBContentUpdated' as any, (e: any) =>
      this.push({ store: 'indexedDB', operation: 'written', key: `${e.databaseName} / ${e.objectStoreName}` }));
    this.client.on('Storage.indexedDBListUpdated' as any, () =>
      this.push({ store: 'indexedDB', operation: 'changed', key: 'databases' }));
    await this.trackIndexedDB();
    // IndexedDB is tracked per storage key, so a navigation to another origin
    // is tracked afresh.
    this.client.on('Page.frameNavigated' as any, (e: any) => {
      if (!e?.frame?.parentId) void this.trackIndexedDB();
    });

    await this.readCookies();
    this.timer = setInterval(() => { void this.readCookies(); }, COOKIE_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Writes that landed from `from` up to, not including, `to`. */
  between(from: number, to: number): PageWrite[] {
    return this.writes.filter(write => write.at >= from && write.at < to);
  }

  private async trackIndexedDB(): Promise<void> {
    try {
      const { frameTree } = await call(this.client, 'Page.getFrameTree');
      const { storageKey } = await call(this.client, 'Storage.getStorageKeyForFrame', { frameId: frameTree.frame.id });
      if (!storageKey || storageKey === this.trackedKey) return;
      if (this.trackedKey) {
        await call(this.client, 'Storage.untrackIndexedDBForStorageKey', { storageKey: this.trackedKey }).catch(() => {});
      }
      await call(this.client, 'Storage.trackIndexedDBForStorageKey', { storageKey });
      this.trackedKey = storageKey;
    } catch {
      // A page with no storage key - about:blank, a data URL - has no IndexedDB to watch.
    }
  }

  private async readCookies(): Promise<void> {
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
      this.push({ store: 'cookie', operation: was === undefined ? 'set' : 'changed', key: name, value: rest.join('=') });
    }
    for (const [id, pair] of before) {
      if (!now.has(id)) this.push({ store: 'cookie', operation: 'removed', key: pair.split('=')[0] });
    }
  }
}

/** One write in a line: `localStorage set draft = {"body":…}`. */
export function writeLine(write: PageWrite): string {
  const value = write.value !== undefined ? ` = ${write.value.slice(0, 80)}` : '';
  return `${write.store} ${write.operation}${write.key ? ` ${write.key}` : ''}${value}`;
}
