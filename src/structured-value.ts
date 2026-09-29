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
