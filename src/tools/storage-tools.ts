/**
 * Storage Access Tools
 */

import { z } from 'zod';
import type { CDPManager } from '../cdp-manager.js';
import { PuppeteerManager } from '../puppeteer-manager.js';
import { executeWithPauseDetection, actionFailureResponse } from '../debugger-aware-wrapper.js';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse, formatCodeBlock } from '../messages.js';
import type { StorageToolMeta } from '../tool-response.js';

export { describeStructuredValue } from '../structured-value.js';
import { describeStructuredValue } from '../structured-value.js';

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
    'authenticatorAdd', 'authenticatorCredentials', 'authenticatorRemove',
  ]).describe('Storage action: getCookies, setCookie, getLocalStorage, setLocalStorage, removeLocalStorage (delete one localStorage key), getSessionStorage, setSessionStorage, removeSessionStorage (delete one sessionStorage key), idbListDatabases, idbListStores, idbGet, idbGetAll, idbPut, idbDelete, clear (clear storage), writes (localStorage and sessionStorage writes as they happened, which no state read can show - these cross no network boundary, so a step that only wrote locally has no other evidence), authenticatorAdd (a virtual WebAuthn authenticator on this page, answering passkey prompts), authenticatorCredentials (the passkeys it holds), authenticatorRemove'),
  connectionReason: z.string().describe('The connection, by the name connection launch or attach gave it (e.g. "unnamed-connection-default")'),
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
  userVerified: z.boolean().optional().describe('authenticatorAdd: whether the authenticator reports the user verified (default: true)'),
  types: z.array(z.enum(['cookies', 'localStorage', 'sessionStorage', 'indexedDB'])).optional().describe('Storage types to clear (for clear action, default: cookies + localStorage + sessionStorage; indexedDB must be requested explicitly)'),
}).strict();

/** The target an ACTION_FAILED reply names for a web storage call. */
const localStorageKey = (key: string | number | undefined) => key === undefined ? 'localStorage' : `localStorage[${String(key)}]`;
const sessionStorageKey = (key: string | number | undefined) => key === undefined ? 'sessionStorage' : `sessionStorage[${String(key)}]`;

/** The virtual authenticator each page holds, and the session it lives on. The
 *  authenticator stands while its session does, so the session is kept. */
const authenticators = new WeakMap<object, { session: any; authenticatorId: string; userVerified: boolean }>();

export function createStorageTools(
  resolveConnectionFromReason: (connectionReason: string) => Promise<{
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

        const resolved = await resolveConnectionFromReason(connectionReason);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', { reference: connectionReason });
        }
        if (!resolved.puppeteerManager) {
          return createErrorResponse('PUPPETEER_NOT_CONNECTED');
        }
        const targetPuppeteerManager: PuppeteerManager = resolved.puppeteerManager;
        const targetCdpManager = resolved.cdpManager;
        const targetNetworkMonitor = resolved.networkMonitor;

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
          case 'authenticatorAdd': {
            const held = authenticators.get(page);
            if (held) {
              await held.session.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: held.authenticatorId }).catch(() => {});
            }
            const userVerified = args.userVerified !== false;
            const session = held?.session ?? await (page as any).createCDPSession();
            await session.send('WebAuthn.enable', { enableUI: false });
            const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', {
              options: {
                protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
                hasUserVerification: true, isUserVerified: userVerified, automaticPresenceSimulation: true,
              },
            });
            authenticators.set(page, { session, authenticatorId, userVerified });
            return {
              content: [{ type: 'text', text: `Virtual authenticator ${authenticatorId} added; passkey prompts on this page are answered${userVerified ? ' with the user verified' : ' with the user present and not verified'}.` }],
              _meta: { tool: 'storage', action, timestamp: Date.now(), storage: { authenticator: { id: authenticatorId, userVerified } } },
            };
          }

          case 'authenticatorCredentials': {
            const held = authenticators.get(page);
            if (!held) return createErrorResponse('NO_AUTHENTICATOR', {});
            const { credentials } = await held.session.send('WebAuthn.getCredentials', { authenticatorId: held.authenticatorId });
            // The private key is the authenticator's, and never leaves it here.
            const listed = (credentials ?? []).map((c: any) => ({ credentialId: c.credentialId, rpId: c.rpId, userHandle: c.userHandle, signCount: c.signCount, resident: c.isResidentCredential }));
            return {
              content: [{ type: 'text', text: `${listed.length} passkey(s)\n\n${formatCodeBlock(listed)}` }],
              _meta: { tool: 'storage', action, timestamp: Date.now(), storage: { authenticator: { id: held.authenticatorId, credentials: listed } } },
            };
          }

          case 'authenticatorRemove': {
            const held = authenticators.get(page);
            if (!held) return createErrorResponse('NO_AUTHENTICATOR', {});
            await held.session.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: held.authenticatorId });
            authenticators.delete(page);
            return {
              content: [{ type: 'text', text: `Virtual authenticator ${held.authenticatorId} removed.` }],
              _meta: { tool: 'storage', action, timestamp: Date.now(), storage: { authenticator: { id: held.authenticatorId, removed: true } } },
            };
          }

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
                if (key !== undefined) {
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
            {
              const failed = actionFailureResponse(result, 'getLocalStorage', localStorageKey(args.key));
              if (failed) return failed;
            }

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
            const result = await executeWithPauseDetection(
              targetCdpManager,
              () => page.evaluate((key: string, value: string) => {
                localStorage.setItem(key, value);
                return true;
              }, String(args.key!), args.value!),
              'setLocalStorage'
            );
            {
              const failed = actionFailureResponse(result, 'setLocalStorage', localStorageKey(args.key));
              if (failed) return failed;
            }

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
            {
              const failed = actionFailureResponse(result, 'removeLocalStorage', localStorageKey(args.key));
              if (failed) return failed;
            }

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
                if (key !== undefined) {
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
            {
              const failed = actionFailureResponse(result, 'getSessionStorage', sessionStorageKey(args.key));
              if (failed) return failed;
            }

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
            const result = await executeWithPauseDetection(
              targetCdpManager,
              () => page.evaluate((key: string, value: string) => {
                sessionStorage.setItem(key, value);
                return true;
              }, String(args.key!), args.value!),
              'setSessionStorage'
            );
            {
              const failed = actionFailureResponse(result, 'setSessionStorage', sessionStorageKey(args.key));
              if (failed) return failed;
            }

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
            {
              const failed = actionFailureResponse(result, 'removeSessionStorage', sessionStorageKey(args.key));
              if (failed) return failed;
            }

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
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : (result.error ?? (result.pausedAtBreakpoint ? 'execution is paused at a breakpoint' : 'No result returned from the page')) });
            }

            const markdown = `## IndexedDB Databases\n\n**Count:** ${idb.databases.length}\n\n${formatCodeBlock(idb.databases)}`;
            return { content: [{ type: 'text', text: markdown }] };
          }

          case 'idbListStores': {
            const result = await runIdbOperation('idbListStores', { db: args.db });
            const idb = result.result;
            if (!idb || !idb.ok) {
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : (result.error ?? (result.pausedAtBreakpoint ? 'execution is paused at a breakpoint' : 'No result returned from the page')) });
            }

            const markdown = `## IndexedDB Object Stores\n\n**Database:** ${idb.database} (v${idb.version})\n**Stores:** ${idb.stores.length}\n\n${formatCodeBlock(idb.stores)}`;
            return { content: [{ type: 'text', text: markdown }] };
          }

          case 'idbGet': {
            const result = await runIdbOperation('idbGet', { db: args.db, store: args.store, key: args.key });
            const idb = result.result;
            if (!idb || !idb.ok) {
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : (result.error ?? (result.pausedAtBreakpoint ? 'execution is paused at a breakpoint' : 'No result returned from the page')) });
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
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : (result.error ?? (result.pausedAtBreakpoint ? 'execution is paused at a breakpoint' : 'No result returned from the page')) });
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
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : (result.error ?? (result.pausedAtBreakpoint ? 'execution is paused at a breakpoint' : 'No result returned from the page')) });
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
              return createErrorResponse('INDEXEDDB_ERROR', { action, error: idb ? idb.error : (result.error ?? (result.pausedAtBreakpoint ? 'execution is paused at a breakpoint' : 'No result returned from the page')) });
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
            console.error(`[devharness] clearStorage called - Reason: ${args.reason}, Types: ${types.join(', ')}, Connection: ${connectionReason}`);

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

            {
              const failed = actionFailureResponse(result, 'clear', types.join(', '));
              if (failed) return failed;
            }
            return createSuccessResponse('STORAGE_CLEARED', { types: result.result!.cleared.join(', ') });
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
