/**
 * Storage Access Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection } from '../debugger-aware-wrapper.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import type { StorageToolMeta } from '../tool-response.js';

/**
 * Describe an arbitrary structured-clone value as JSON-expressible data.
 *
 * IndexedDB stores structured-clone values, and several of the most interesting
 * ones (a non-extractable `CryptoKey`, a `Blob`, an `ArrayBuffer`) serialize to
 * `{}` under JSON - which is exactly the case the caller most wants to assert
 * on. Instead of dropping them, emit a typed descriptor:
 *
 *   { __type: 'CryptoKey', keyType, algorithm, extractable, usages }
 *
 * so "an unwrappable signing key is present, P-256, non-extractable" is
 * observable even though the key material is not.
 *
 * BUDGETS: `maxDepth`/`maxItems` are per-path and per-container, so they
 * multiply rather than bound - a 500-wide array whose elements share a 500-wide
 * array, repeated, is 500^6 visited nodes and pins the page's main thread. Two
 * TOTAL budgets bound the whole walk instead: `maxNodes` (values visited) and
 * `maxTotalChars` (characters emitted). Long strings are capped individually by
 * `maxStringLength`. Whenever a budget or a string cap trips, an explicit
 * marker is emitted ({__type:'BudgetExceeded'} / {__type:'String',truncated})
 * and the top-level result is flagged, so a truncated read is never mistaken
 * for a complete one.
 *
 * IMPORTANT: this function is injected into the page by stringifying it (see
 * `SERIALIZER_SOURCE`), so it must be entirely self-contained - no imports, no
 * closure variables, no references to anything outside its own body. Everything
 * it needs is defined inline. It is exported so it can be unit-tested directly
 * in Node without a browser.
 */
export function describeStructuredValue(
  value: any,
  options?: {
    maxDepth?: number;
    maxItems?: number;
    maxNodes?: number;
    maxTotalChars?: number;
    maxStringLength?: number;
  }
): any {
  const opts = options || {};
  const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 6;
  const maxItems = typeof opts.maxItems === 'number' ? opts.maxItems : 500;
  // Total (not per-container) budgets: these are what actually bound the walk.
  const maxNodes = typeof opts.maxNodes === 'number' ? opts.maxNodes : 10000;
  const maxTotalChars = typeof opts.maxTotalChars === 'number' ? opts.maxTotalChars : 250000;
  const maxStringLength = typeof opts.maxStringLength === 'number' ? opts.maxStringLength : 10000;

  let nodes = 0;
  let chars = 0;
  // '' while inside budget, otherwise the name of the budget that tripped.
  let budgetHit = '';

  // Ancestor stack, not a global "seen" set: two siblings pointing at the same
  // object is a DAG, not a cycle, and should serialize twice rather than be
  // reported as circular.
  const stack: any[] = [];
  const stackPaths: string[] = [];
  // Host constructors are looked up off the global rather than referenced
  // directly: this body is stringified and eval'd in the page, and `CryptoKey`
  // is not even a name the server's own realm knows.
  const g: any = typeof globalThis !== 'undefined' ? (globalThis as any) : {};

  function className(v: any): string {
    try {
      return v && v.constructor && v.constructor.name ? String(v.constructor.name) : '';
    } catch {
      return '';
    }
  }

  function describe(v: any, depth: number, path: string): any {
    // Total budget check before anything else: every unit of work in this walk
    // happens inside a describe() call, so gating here bounds all of it.
    if (budgetHit) return { __type: 'BudgetExceeded', limit: budgetHit };
    nodes++;
    if (nodes > maxNodes) {
      budgetHit = 'maxNodes';
      return { __type: 'BudgetExceeded', limit: 'maxNodes' };
    }
    if (chars > maxTotalChars) {
      budgetHit = 'maxTotalChars';
      return { __type: 'BudgetExceeded', limit: 'maxTotalChars' };
    }
    chars += 4; // rough per-value overhead, so a wide tree of tiny values still costs

    if (v === null) return null;

    const t = typeof v;
    if (t === 'undefined') return { __type: 'Undefined' };
    if (t === 'boolean') return v;
    if (t === 'string') {
      // A single record can hold a multi-megabyte string; returning it verbatim
      // would put the whole thing in the MCP response.
      if (v.length > maxStringLength) {
        chars += maxStringLength;
        return { __type: 'String', length: v.length, truncated: true, value: v.slice(0, maxStringLength) };
      }
      chars += v.length;
      return v;
    }
    if (t === 'number') {
      // NaN/Infinity are not JSON-expressible; keep them visible.
      return isFinite(v) ? v : { __type: 'Number', value: String(v) };
    }
    if (t === 'bigint') return { __type: 'BigInt', value: String(v) };
    if (t === 'symbol') return { __type: 'Symbol', description: String(v) };
    if (t === 'function') return { __type: 'Function', name: v.name || '(anonymous)' };

    // Cycle check first, so a cycle is reported as a cycle even at max depth.
    const seenAt = stack.indexOf(v);
    if (seenAt !== -1) return { __type: 'Circular', path: stackPaths[seenAt] };
    if (depth > maxDepth) return { __type: 'MaxDepth', className: className(v) || 'Object' };

    // A value with a throwing Symbol.toStringTag getter would otherwise abort
    // the entire read through the caller's catch.
    let tag = '';
    try {
      tag = Object.prototype.toString.call(v);
    } catch {
      tag = '';
    }
    const ctor = className(v);

    if (tag === '[object Date]') {
      const time = v.getTime();
      return { __type: 'Date', iso: isFinite(time) ? v.toISOString() : null, time: isFinite(time) ? time : null };
    }
    if (tag === '[object RegExp]') {
      return { __type: 'RegExp', source: v.source, flags: v.flags };
    }
    if (tag === '[object Error]' || (typeof Error !== 'undefined' && v instanceof Error)) {
      return { __type: 'Error', name: String(v.name), message: String(v.message) };
    }

    // Host objects: match on constructor name too, since a value from another
    // realm fails `instanceof` even though it is the real thing.
    if (ctor === 'CryptoKey' || (g.CryptoKey && v instanceof g.CryptoKey)) {
      return {
        __type: 'CryptoKey',
        keyType: v.type,
        extractable: v.extractable,
        usages: v.usages ? Array.prototype.slice.call(v.usages) : [],
        algorithm: describe(v.algorithm, depth + 1, path + '.algorithm'),
      };
    }
    if (ctor === 'File' || (g.File && v instanceof g.File)) {
      return { __type: 'File', name: v.name, size: v.size, mimeType: v.type, lastModified: v.lastModified };
    }
    if (ctor === 'Blob' || (g.Blob && v instanceof g.Blob)) {
      return { __type: 'Blob', size: v.size, mimeType: v.type };
    }
    if (tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]') {
      return { __type: ctor === 'SharedArrayBuffer' ? 'SharedArrayBuffer' : 'ArrayBuffer', byteLength: v.byteLength };
    }
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(v)) {
      const out: any = {
        __type: ctor || 'ArrayBufferView',
        byteLength: v.byteLength,
        byteOffset: v.byteOffset,
      };
      if (tag !== '[object DataView]') {
        out.length = (v as any).length;
        const preview = Array.prototype.slice.call(v as any, 0, 16);
        out.preview = preview.map((n: any) => (typeof n === 'bigint' ? String(n) : n));
        if ((v as any).length > preview.length) out.previewTruncated = true;
      }
      return out;
    }

    stack.push(v);
    stackPaths.push(path);
    try {
      if (tag === '[object Map]') {
        const entries: any[] = [];
        let i = 0;
        v.forEach((val: any, k: any) => {
          if (i < maxItems && !budgetHit) {
            entries.push([describe(k, depth + 1, path + '.<key ' + i + '>'), describe(val, depth + 1, path + '.<value ' + i + '>')]);
          }
          i++;
        });
        const out: any = { __type: 'Map', size: v.size, entries };
        if (v.size > entries.length) out.truncated = true;
        return out;
      }
      if (tag === '[object Set]') {
        const values: any[] = [];
        let i = 0;
        v.forEach((val: any) => {
          if (i < maxItems && !budgetHit) values.push(describe(val, depth + 1, path + '[' + i + ']'));
          i++;
        });
        const out: any = { __type: 'Set', size: v.size, values };
        if (v.size > values.length) out.truncated = true;
        return out;
      }
      if (Array.isArray(v)) {
        const limit = Math.min(v.length, maxItems);
        const out: any[] = [];
        for (let i = 0; i < limit; i++) {
          if (budgetHit) break;
          out.push(describe(v[i], depth + 1, path + '[' + i + ']'));
        }
        if (v.length > limit) out.push({ __type: 'Truncated', omitted: v.length - limit });
        return out;
      }

      const out: any = {};
      if (ctor && ctor !== 'Object') out.__class = ctor;
      let keys: string[] = [];
      try {
        keys = Object.keys(v);
      } catch {
        keys = [];
      }
      const limit = Math.min(keys.length, maxItems);
      for (let i = 0; i < limit; i++) {
        if (budgetHit) break;
        const k = keys[i];
        chars += k.length + 4;
        let child: any;
        try {
          child = v[k];
        } catch (e: any) {
          out[k] = { __type: 'Unreadable', reason: String(e && e.message ? e.message : e) };
          continue;
        }
        out[k] = describe(child, depth + 1, path + '.' + k);
      }
      if (keys.length > limit) out.__truncated = keys.length - limit;
      return out;
    } finally {
      stack.pop();
      stackPaths.pop();
    }
  }

  const result = describe(value, 0, '$');
  // Silent truncation is worse than the unbounded walk: flag the top level so a
  // caller can tell a partial read from a complete one without hunting for an
  // inline marker.
  if (budgetHit) {
    if (Array.isArray(result)) {
      result.push({ __type: 'BudgetExceeded', limit: budgetHit });
    } else if (result && typeof result === 'object') {
      try {
        result.__budgetExceeded = budgetHit;
      } catch {
        /* frozen or exotic result object - the inline markers still show it */
      }
    }
  }
  return result;
}

/**
 * The serializer's own source, injected into the page as a string argument and
 * re-created there with `eval`. `page.evaluate` stringifies the callback, so a
 * lexical reference to `describeStructuredValue` would be undefined in-page.
 */
const SERIALIZER_SOURCE = describeStructuredValue.toString();

/**
 * Presence for a localStorage/sessionStorage read, structurally. `getItem`
 * returns null only when the key is absent, so a stored empty string still
 * counts as present - which reading the rendered JSON could not tell apart.
 */
export function webStorageMeta(items: any, key?: string | number): StorageToolMeta {
  if (key === undefined) {
    return { count: Object.keys(items ?? {}).length };
  }
  const name = String(key);
  return { key: name, found: items?.[name] !== null && items?.[name] !== undefined };
}

// Consolidated schema for storage tools
const storageSchema = z.object({
  action: z.enum([
    'getCookies', 'setCookie',
    'getLocalStorage', 'setLocalStorage', 'removeLocalStorage',
    'getSessionStorage', 'setSessionStorage', 'removeSessionStorage',
    'idbListDatabases', 'idbListStores', 'idbGet', 'idbGetAll', 'idbPut', 'idbDelete',
    'clear', 'writes',
  ]).describe('Storage action: getCookies, setCookie, getLocalStorage, setLocalStorage, removeLocalStorage (delete one localStorage key), getSessionStorage, setSessionStorage, removeSessionStorage (delete one sessionStorage key), idbListDatabases, idbListStores, idbGet, idbGetAll, idbPut, idbDelete, clear (clear storage), writes (localStorage and sessionStorage writes as they happened, which no state read can show - these cross no network boundary, so a step that only wrote locally has no other evidence)'),
  connectionReason: z.string().optional().describe('Connection reference (use the reference from launchChrome output, e.g., "unnamed-connection-default" or your renamed tab)'),
  since: z.number().optional().describe('writes: epoch ms. Only writes at or after this, so a step\'s own writes separate from the rest'),
  until: z.number().optional().describe('writes: epoch ms. Only writes before this'),

  // Parameters for getCookies action
  url: z.string().optional().describe('URL to get cookies for (optional for getCookies action)'),
  // Parameters for setCookie action
  name: z.string().optional().describe('Cookie name (required for setCookie action)'),
  value: z.string().optional().describe('Cookie/storage value (required for setCookie and setLocalStorage actions)'),
  domain: z.string().optional().describe('Cookie domain (optional for setCookie action)'),
  path: z.string().optional().describe('Cookie path (optional for setCookie action)'),
  expires: z.number().optional().describe('Cookie expiration timestamp (optional for setCookie action)'),
  httpOnly: z.boolean().optional().describe('HTTP only cookie (optional for setCookie action, default: false)'),
  secure: z.boolean().optional().describe('Secure cookie (optional for setCookie action, default: false)'),
  // Parameters for localStorage/sessionStorage and IndexedDB key lookups
  key: z.union([z.string(), z.number()]).optional().describe('Storage key. Optional for getLocalStorage/getSessionStorage (omit to read the whole store), required for setLocalStorage/setSessionStorage/removeLocalStorage/removeSessionStorage/idbGet/idbDelete. Numbers are only meaningful for IndexedDB keys'),
  // Parameters for IndexedDB actions
  db: z.string().optional().describe('IndexedDB database name (required for idbListStores/idbGet/idbGetAll/idbPut/idbDelete)'),
  store: z.string().optional().describe('IndexedDB object store name (required for idbGet/idbGetAll/idbPut/idbDelete)'),
  record: z.any().optional().describe('Value to write for idbPut. Must be JSON-expressible - structured-clone-only types (CryptoKey, Blob/File, ArrayBuffer, Map/Set) cannot be created from JSON and so cannot be written through this tool'),
  limit: z.number().optional().describe('Maximum records to return for idbGetAll (default: 50)'),
  // Parameters for clear action
  reason: z.string().optional().describe('Why storage needs to be cleared (required for clear action)'),
  types: z.array(z.enum(['cookies', 'localStorage', 'sessionStorage', 'indexedDB'])).optional().describe('Storage types to clear (for clear action, default: cookies + localStorage + sessionStorage; indexedDB must be requested explicitly)'),
}).strict();

export function createStorageTools(
  puppeteerManager: PuppeteerManager,
  cdpManager: CDPManager,
  resolveConnectionFromReason?: (connectionReason: string) => Promise<{
    connection: any;
    cdpManager: CDPManager;
    puppeteerManager: any;
    consoleMonitor: any;
    networkMonitor: any;
  } | null>
) {
  return {
    storage: createTool(
      'Access and manage browser storage (cookies, localStorage, sessionStorage, IndexedDB). ' +
      'Cookies: getCookies, setCookie. ' +
      'localStorage: getLocalStorage (omit key to read the whole store), setLocalStorage, removeLocalStorage (delete one key). ' +
      'sessionStorage: getSessionStorage, setSessionStorage, removeSessionStorage - a full peer of localStorage. ' +
      'IndexedDB: idbListDatabases, idbListStores({db}), idbGet({db,store,key}), idbGetAll({db,store,limit}), idbPut({db,store,record,key?}), idbDelete({db,store,key}). ' +
      'IndexedDB reads return values that JSON cannot represent as typed descriptors instead of dropping them - e.g. {__type:"CryptoKey",keyType,algorithm,extractable,usages}, and the same for Blob/File, ArrayBuffer and typed arrays, Map, Set, Date, RegExp and BigInt; cycles come back as {__type:"Circular",path}. That makes a non-extractable key assertable even though its material cannot be read. ' +
      'Very large values are bounded rather than returned whole: an oversized read is marked with {__type:"BudgetExceeded"} (plus "__budgetExceeded" at the top level) and a long string comes back as {__type:"String",length,truncated:true,value}, so a partial read is always distinguishable from a complete one. ' +
      'idbPut is the reverse and is limited: "record" must be JSON-expressible, so structured-clone-only values (CryptoKey, Blob/File, ArrayBuffer, Map/Set) cannot be written through this tool - create those in-page with inspect({action:"evaluateExpression"}). ' +
      'clear wipes storage by type (cookies, localStorage, sessionStorage, and indexedDB when explicitly requested).',
      storageSchema,
      async (args) => {
        const { action, connectionReason } = args;

        // Validate required parameters for each action
        if (action === 'setCookie') {
          if (!args.name) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'setCookie',
              missing: 'name',
              message: 'The "setCookie" action requires a "name" parameter'
            });
          }
          // `=== undefined`, not falsy: '' is a legitimate value (clearing a
          // flag) and 0 is a legitimate key.
          if (args.value === undefined) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'setCookie',
              missing: 'value',
              message: 'The "setCookie" action requires a "value" parameter'
            });
          }
        }
        if (action === 'setLocalStorage') {
          if (args.key === undefined) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'setLocalStorage',
              missing: 'key',
              message: 'The "setLocalStorage" action requires a "key" parameter'
            });
          }
          if (args.value === undefined) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'setLocalStorage',
              missing: 'value',
              message: 'The "setLocalStorage" action requires a "value" parameter'
            });
          }
        }
        if (action === 'setSessionStorage') {
          if (args.key === undefined) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'setSessionStorage',
              missing: 'key',
              message: 'The "setSessionStorage" action requires a "key" parameter'
            });
          }
          if (args.value === undefined) {
            return createErrorResponse('MISSING_PARAMETER', {
              action: 'setSessionStorage',
              missing: 'value',
              message: 'The "setSessionStorage" action requires a "value" parameter'
            });
          }
        }
        if ((action === 'removeLocalStorage' || action === 'removeSessionStorage') && args.key === undefined) {
          return createErrorResponse('MISSING_PARAMETER', {
            action,
            missing: 'key',
            message: `The "${action}" action requires a "key" parameter`
          });
        }
        // IndexedDB actions: db/store/key requirements
        if (action === 'idbListStores' && !args.db) {
          return createErrorResponse('MISSING_PARAMETER', {
            action,
            missing: 'db',
            message: 'The "idbListStores" action requires a "db" parameter (use idbListDatabases to discover names)'
          });
        }
        if (action === 'idbGet' || action === 'idbGetAll' || action === 'idbPut' || action === 'idbDelete') {
          if (!args.db) {
            return createErrorResponse('MISSING_PARAMETER', {
              action,
              missing: 'db',
              message: `The "${action}" action requires a "db" parameter (use idbListDatabases to discover names)`
            });
          }
          if (!args.store) {
            return createErrorResponse('MISSING_PARAMETER', {
              action,
              missing: 'store',
              message: `The "${action}" action requires a "store" parameter (use idbListStores to discover names)`
            });
          }
        }
        if ((action === 'idbGet' || action === 'idbDelete') && args.key === undefined) {
          return createErrorResponse('MISSING_PARAMETER', {
            action,
            missing: 'key',
            message: `The "${action}" action requires a "key" parameter`
          });
        }
        if (action === 'idbPut' && args.record === undefined) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: 'idbPut',
            missing: 'record',
            message: 'The "idbPut" action requires a "record" parameter (the JSON-expressible value to store)'
          });
        }
        if (action === 'clear' && !args.reason) {
          return createErrorResponse('MISSING_PARAMETER', {
            action: 'clear',
            missing: 'reason',
            message: 'The "clear" action requires a "reason" parameter'
          });
        }

        // Resolve connection if connectionReason is provided
        let targetPuppeteerManager = puppeteerManager;
        let targetCdpManager = cdpManager;
        let targetNetworkMonitor: any = null;
        if (connectionReason && resolveConnectionFromReason) {
          const resolved = await resolveConnectionFromReason(connectionReason);
          if (!resolved || !resolved.puppeteerManager) {
            return createErrorResponse('PUPPETEER_NOT_CONNECTED');
          }
          targetPuppeteerManager = resolved.puppeteerManager;
          targetCdpManager = resolved.cdpManager;
          targetNetworkMonitor = resolved.networkMonitor;
        }

        if (action === 'writes') {
          if (!targetNetworkMonitor) {
            return createErrorResponse('PUPPETEER_NOT_CONNECTED');
          }
          const writes = targetNetworkMonitor.getStorageWrites(args.since, args.until);
          const lines = writes.map((w: any) => {
            const value = w.value === undefined ? '' : ` ${w.value.slice(0, 160)}${w.truncated ? ' …' : ''}`;
            const key = w.key ? ` ${w.key}` : '';
            return `${w.area}Storage ${w.operation}${key}${value}`;
          });
          const text = writes.length === 0
            ? 'No localStorage or sessionStorage writes recorded. Capture starts with the connection, so a write made before then is not held. IndexedDB emits no write event and is not covered.'
            : `${writes.length} write(s)\n\n${lines.join('\n')}`;
          return {
            content: [{ type: 'text', text }],
            _meta: {
              tool: 'storage', action: 'writes', timestamp: Date.now(),
              storage: { writes },
            },
          };
        }

        if (!targetPuppeteerManager.isConnected()) {
          return createErrorResponse('PUPPETEER_NOT_CONNECTED');
        }

        const page = targetPuppeteerManager.getPage();

        /**
         * Run one IndexedDB operation inside the page.
         *
         * Everything IndexedDB-shaped lives in this single in-page function:
         * open the database, run the request, wait for the transaction to
         * settle, close. Values come back through the injected serializer so
         * structured-clone-only types survive as descriptors instead of `{}`.
         */
        const runIdbOperation = (op: string, payload: Record<string, any>) => executeWithPauseDetection(
          targetCdpManager,
          () => page.evaluate(async (input: any, serializerSource: string) => {
            const describe: (v: any) => any = (0, eval)('(' + serializerSource + ')');
            const indexedDB: any = (globalThis as any).indexedDB;
            const asRequest = (r: any) => new Promise<any>((resolve, reject) => {
              r.onsuccess = () => resolve(r.result);
              r.onerror = () => reject(r.error || new Error('IndexedDB request failed'));
            });

            try {
              if (input.op === 'idbListDatabases') {
                if (!indexedDB || typeof indexedDB.databases !== 'function') {
                  return { ok: false, error: 'indexedDB.databases() is not supported in this browser' };
                }
                const dbs = await indexedDB.databases();
                return { ok: true, databases: dbs.map((d: any) => ({ name: d.name, version: d.version })) };
              }

              // Opening a name that does not exist would silently CREATE an
              // empty database - a read must not have that side effect, so
              // detect the upgrade and undo it.
              let created = false;
              const openReq = indexedDB.open(input.db);
              openReq.onupgradeneeded = () => { created = true; };
              const db: any = await new Promise((resolve, reject) => {
                openReq.onsuccess = () => resolve(openReq.result);
                openReq.onerror = () => reject(openReq.error || new Error('Failed to open database'));
                openReq.onblocked = () => reject(new Error('Opening the database is blocked by another connection'));
              });

              if (created) {
                db.close();
                indexedDB.deleteDatabase(input.db);
                return { ok: false, error: 'Database "' + input.db + '" does not exist', notFound: true };
              }

              const version = db.version;

              if (input.op === 'idbListStores') {
                const names: string[] = Array.prototype.slice.call(db.objectStoreNames);
                const stores: any[] = [];
                if (names.length > 0) {
                  const tx = db.transaction(names, 'readonly');
                  for (const n of names) {
                    const s = tx.objectStore(n);
                    stores.push({
                      name: n,
                      keyPath: s.keyPath === null ? null : s.keyPath,
                      autoIncrement: s.autoIncrement,
                      indexes: Array.prototype.slice.call(s.indexNames),
                      count: await asRequest(s.count()),
                    });
                  }
                }
                db.close();
                return { ok: true, database: input.db, version, stores };
              }

              if (!db.objectStoreNames.contains(input.store)) {
                const available: string[] = Array.prototype.slice.call(db.objectStoreNames);
                db.close();
                return {
                  ok: false,
                  error: 'Object store "' + input.store + '" not found in database "' + input.db + '"',
                  availableStores: available,
                };
              }

              const writing = input.op === 'idbPut' || input.op === 'idbDelete';
              const tx = db.transaction(input.store, writing ? 'readwrite' : 'readonly');
              // Attach settle handlers immediately: a read-only transaction can
              // complete before the awaits below finish, and a handler attached
              // after the fact would never fire.
              const txSettled = new Promise<void>((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('Transaction failed'));
                tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
              });
              // The validation branches below abort the transaction and return
              // early without awaiting it; keep that from surfacing as an
              // unhandled rejection in the page.
              txSettled.catch(() => {});
              const store = tx.objectStore(input.store);

              let out: any = {};
              if (input.op === 'idbGet') {
                const raw = await asRequest(store.get(input.key));
                out = { found: raw !== undefined, key: input.key, value: raw === undefined ? null : describe(raw) };
              } else if (input.op === 'idbGetAll') {
                const keys = await asRequest(store.getAllKeys(null, input.limit));
                const values = await asRequest(store.getAll(null, input.limit));
                const total = await asRequest(store.count());
                out = {
                  count: values.length,
                  total,
                  truncated: total > values.length,
                  records: values.map((v: any, i: number) => ({ key: describe(keys[i]), value: describe(v) })),
                };
              } else if (input.op === 'idbPut') {
                const hasKey = input.key !== undefined && input.key !== null;
                if (store.keyPath !== null && hasKey) {
                  tx.abort();
                  db.close();
                  return {
                    ok: false,
                    error: 'Object store "' + input.store + '" uses an in-line key (keyPath ' + JSON.stringify(store.keyPath) + '), so "key" must not be supplied - put the key inside "record" instead',
                  };
                }
                if (store.keyPath === null && !hasKey && !store.autoIncrement) {
                  tx.abort();
                  db.close();
                  return {
                    ok: false,
                    error: 'Object store "' + input.store + '" uses out-of-line keys without autoIncrement, so a "key" parameter is required',
                  };
                }
                const resultKey = hasKey
                  ? await asRequest(store.put(input.record, input.key))
                  : await asRequest(store.put(input.record));
                out = { key: describe(resultKey) };
              } else if (input.op === 'idbDelete') {
                const existing = await asRequest(store.get(input.key));
                await asRequest(store.delete(input.key));
                out = { existed: existing !== undefined, key: input.key };
              } else {
                tx.abort();
                db.close();
                return { ok: false, error: 'Unknown IndexedDB operation: ' + String(input.op) };
              }

              await txSettled;
              db.close();
              return Object.assign({ ok: true, database: input.db, store: input.store }, out);
            } catch (e: any) {
              return { ok: false, error: String(e && e.message ? e.message : e) };
            }
          }, Object.assign({ op }, payload), SERIALIZER_SOURCE),
          op
        );

        // Handle each action
        switch (action) {
          case 'getCookies': {
            const cookies = args.url ? await page.cookies(args.url) : await page.cookies();

            const markdown = `## Browser Cookies\n\n**Count:** ${cookies.length}\n\n${formatCodeBlock(cookies)}`;
            return {
              content: [
                {
                  type: 'text',
                  text: markdown,
                },
              ],
              // Names structurally, so a caller asking "is this cookie set" never
              // has to grep the rendered JSON - where another cookie's VALUE can
              // contain the text being searched for.
              _meta: {
                tool: 'storage',
                action,
                timestamp: Date.now(),
                storage: { cookieNames: cookies.map((c: any) => c.name), count: cookies.length },
              },
            };
          }

          case 'setCookie': {
            const cookie: any = {
              name: args.name!,
              value: args.value!,
              domain: args.domain,
              path: args.path || '/',
              expires: args.expires,
              httpOnly: args.httpOnly ?? false,
              secure: args.secure ?? false,
            };

            await page.setCookie(cookie);

            return createSuccessResponse('COOKIE_SET_SUCCESS', {
              name: args.name
            }, cookie);
          }

          case 'getLocalStorage': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              () => page.evaluate((key: string | undefined) => {
                if (key) {
                  return { [key]: localStorage.getItem(key) };
                } else {
                  const items: Record<string, string | null> = {};
                  for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k) {
                      items[k] = localStorage.getItem(k);
                    }
                  }
                  return items;
                }
              }, args.key === undefined ? undefined : String(args.key)),
              'getLocalStorage'
            );

            const markdown = `## localStorage\n\n${formatCodeBlock(result.result)}`;
            return {
              content: [
                {
                  type: 'text',
                  text: markdown,
                },
              ],
              _meta: {
                tool: 'storage',
                action,
                timestamp: Date.now(),
                storage: webStorageMeta(result.result, args.key),
              },
            };
          }

          case 'setLocalStorage': {
            await executeWithPauseDetection(
              targetCdpManager,
              () => page.evaluate((key: string, value: string) => {
                localStorage.setItem(key, value);
              }, String(args.key!), args.value!),
              'setLocalStorage'
            );

            return createSuccessResponse('LOCAL_STORAGE_SET_SUCCESS', {
              key: args.key,
              value: args.value
            });
          }

          case 'removeLocalStorage': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              () => page.evaluate((key: string) => {
                const existed = localStorage.getItem(key) !== null;
                localStorage.removeItem(key);
                return { existed };
              }, String(args.key!)),
              'removeLocalStorage'
            );

            return createSuccessResponse('STORAGE_KEY_REMOVED', {
              storageType: 'localStorage',
              key: args.key,
              existedNote: result.result && !result.result.existed ? ' (key was not present)' : ''
            });
          }

          case 'getSessionStorage': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              () => page.evaluate((key: string | undefined) => {
                if (key) {
                  return { [key]: sessionStorage.getItem(key) };
                } else {
                  const items: Record<string, string | null> = {};
                  for (let i = 0; i < sessionStorage.length; i++) {
                    const k = sessionStorage.key(i);
                    if (k) {
                      items[k] = sessionStorage.getItem(k);
                    }
                  }
                  return items;
                }
              }, args.key === undefined ? undefined : String(args.key)),
              'getSessionStorage'
            );

            const markdown = `## sessionStorage\n\n${formatCodeBlock(result.result)}`;
            return {
              content: [
                {
                  type: 'text',
                  text: markdown,
                },
              ],
              _meta: {
                tool: 'storage',
                action,
                timestamp: Date.now(),
                storage: webStorageMeta(result.result, args.key),
              },
            };
          }

          case 'setSessionStorage': {
            await executeWithPauseDetection(
              targetCdpManager,
              () => page.evaluate((key: string, value: string) => {
                sessionStorage.setItem(key, value);
              }, String(args.key!), args.value!),
              'setSessionStorage'
            );

            return createSuccessResponse('SESSION_STORAGE_SET_SUCCESS', {
              key: args.key,
              value: args.value
            });
          }

          case 'removeSessionStorage': {
            const result = await executeWithPauseDetection(
              targetCdpManager,
              () => page.evaluate((key: string) => {
                const existed = sessionStorage.getItem(key) !== null;
                sessionStorage.removeItem(key);
                return { existed };
              }, String(args.key!)),
              'removeSessionStorage'
            );

            return createSuccessResponse('STORAGE_KEY_REMOVED', {
              storageType: 'sessionStorage',
              key: args.key,
              existedNote: result.result && !result.result.existed ? ' (key was not present)' : ''
            });
          }

          case 'idbListDatabases': {
            const result = await runIdbOperation('idbListDatabases', {});
            const idb = result.result;
            if (!idb || !idb.ok) {
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : 'No result returned from the page' });
            }

            const markdown = `## IndexedDB Databases\n\n**Count:** ${idb.databases.length}\n\n${formatCodeBlock(idb.databases)}`;
            return { content: [{ type: 'text', text: markdown }] };
          }

          case 'idbListStores': {
            const result = await runIdbOperation('idbListStores', { db: args.db });
            const idb = result.result;
            if (!idb || !idb.ok) {
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : 'No result returned from the page' });
            }

            const markdown = `## IndexedDB Object Stores\n\n**Database:** ${idb.database} (v${idb.version})\n**Stores:** ${idb.stores.length}\n\n${formatCodeBlock(idb.stores)}`;
            return { content: [{ type: 'text', text: markdown }] };
          }

          case 'idbGet': {
            const result = await runIdbOperation('idbGet', { db: args.db, store: args.store, key: args.key });
            const idb = result.result;
            if (!idb || !idb.ok) {
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : 'No result returned from the page' });
            }

            const markdown = idb.found
              ? `## IndexedDB Record\n\n**Database:** ${idb.database}\n**Store:** ${idb.store}\n**Key:** ${JSON.stringify(idb.key)}\n\n${formatCodeBlock(idb.value)}`
              : `## IndexedDB Record\n\n**Database:** ${idb.database}\n**Store:** ${idb.store}\n**Key:** ${JSON.stringify(idb.key)}\n\nNo record found for this key.`;
            return {
              content: [{ type: 'text', text: markdown }],
              _meta: {
                tool: 'storage',
                action,
                timestamp: Date.now(),
                storage: { database: idb.database, store: idb.store, found: !!idb.found },
              },
            };
          }

          case 'idbGetAll': {
            const limit = args.limit ?? 50;
            const result = await runIdbOperation('idbGetAll', { db: args.db, store: args.store, limit });
            const idb = result.result;
            if (!idb || !idb.ok) {
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : 'No result returned from the page' });
            }

            const truncatedNote = idb.truncated ? ` (showing ${idb.count} of ${idb.total}, raise "limit" to see more)` : '';
            const markdown = `## IndexedDB Records\n\n**Database:** ${idb.database}\n**Store:** ${idb.store}\n**Count:** ${idb.count}${truncatedNote}\n\n${formatCodeBlock(idb.records)}`;
            return {
              content: [{ type: 'text', text: markdown }],
              _meta: {
                tool: 'storage',
                action,
                timestamp: Date.now(),
                storage: {
                  database: idb.database,
                  store: idb.store,
                  count: idb.count,
                  ...(idb.total !== undefined && { total: idb.total }),
                },
              },
            };
          }

          case 'idbPut': {
            const result = await runIdbOperation('idbPut', {
              db: args.db,
              store: args.store,
              key: args.key,
              record: args.record,
            });
            const idb = result.result;
            if (!idb || !idb.ok) {
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : 'No result returned from the page' });
            }

            return createSuccessResponse('IDB_PUT_SUCCESS', {
              db: idb.database,
              store: idb.store,
              key: JSON.stringify(idb.key)
            }, args.record);
          }

          case 'idbDelete': {
            const result = await runIdbOperation('idbDelete', { db: args.db, store: args.store, key: args.key });
            const idb = result.result;
            if (!idb || !idb.ok) {
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : 'No result returned from the page' });
            }

            return createSuccessResponse('IDB_DELETE_SUCCESS', {
              db: idb.database,
              store: idb.store,
              key: JSON.stringify(idb.key),
              existedNote: idb.existed ? '' : ' (no record existed for this key)'
            });
          }

          case 'clear': {
            // Log the reason for audit purposes
            const types = args.types || ['cookies', 'localStorage', 'sessionStorage'];
            console.error(`[devharness] clearStorage called - Reason: ${args.reason}, Types: ${types.join(', ')}, Connection: ${connectionReason || 'default'}`);

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                const cleared: string[] = [];

                if (types.includes('cookies')) {
                  const cookies = await page.cookies();
                  if (cookies.length > 0) {
                    await page.deleteCookie(...cookies);
                  }
                  cleared.push('cookies');
                }

                if (types.includes('localStorage') || types.includes('sessionStorage')) {
                  await page.evaluate((storageTypes: string[]) => {
                    if (storageTypes.includes('localStorage')) {
                      localStorage.clear();
                    }
                    if (storageTypes.includes('sessionStorage')) {
                      sessionStorage.clear();
                    }
                  }, types);

                  if (types.includes('localStorage')) cleared.push('localStorage');
                  if (types.includes('sessionStorage')) cleared.push('sessionStorage');
                }

                if (types.includes('indexedDB')) {
                  const idbResult: any = await page.evaluate(async () => {
                    const indexedDB: any = (globalThis as any).indexedDB;
                    if (!indexedDB || typeof indexedDB.databases !== 'function') {
                      return { supported: false, deleted: [], blocked: [] };
                    }
                    const dbs = await indexedDB.databases();
                    const deleted: string[] = [];
                    const blocked: string[] = [];
                    for (const info of dbs) {
                      if (!info.name) continue;
                      // deleteDatabase never settles while another connection
                      // holds the database open, so bound the wait and report
                      // the survivors rather than hanging the tool.
                      const ok = await new Promise<boolean>((resolve) => {
                        const req = indexedDB.deleteDatabase(info.name);
                        const done = (v: boolean) => resolve(v);
                        req.onsuccess = () => done(true);
                        req.onerror = () => done(false);
                        req.onblocked = () => done(false);
                        setTimeout(() => done(false), 3000);
                      });
                      (ok ? deleted : blocked).push(info.name);
                    }
                    return { supported: true, deleted, blocked };
                  });

                  if (idbResult.supported) {
                    cleared.push(`indexedDB (${idbResult.deleted.length} deleted${idbResult.blocked.length ? `, ${idbResult.blocked.length} blocked: ${idbResult.blocked.join(', ')}` : ''})`);
                  } else {
                    cleared.push('indexedDB (skipped: indexedDB.databases() unsupported)');
                  }
                }

                return { cleared };
              },
              'clearStorage'
            );

            if (!result.result) {
              return createSuccessResponse('STORAGE_CLEARED', { types: types.join(', ') });
            }

            const storageResult = result.result;
            return createSuccessResponse('STORAGE_CLEARED', { types: storageResult.cleared.join(', ') });
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
