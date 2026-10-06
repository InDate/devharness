/**
 * CDP Connection Manager
 * Handles connection to Chrome DevTools Protocol (Chrome or Node.js)
 */

import CDP from 'chrome-remote-interface';
import type { BreakpointInfo, CallFrame, DebuggerState, RuntimeType, CDPConsoleMessage, ConsoleMessageCallback, DOMBreakpointInfo, DOMBreakpointType, EventListenerBreakpointInfo, XHRBreakpointInfo } from './types.js';
import type { SourceMapHandler } from './sourcemap-handler.js';
import { debugLog } from './debug-logger.js';

/** Scripts devharness itself runs in a page, which Puppeteer names pptr:…. */
const OWN_SCRIPTS = /^pptr:/;

/**
 * Thrown by evaluateExpression() when the evaluated code itself threw
 * (CDP reports this via `exceptionDetails` on an otherwise-successful
 * Runtime.evaluate/Debugger.evaluateOnCallFrame response, NOT as a rejected
 * promise) - e.g. `Math.max(...bigArray)` throwing a stack-exhaustion
 * RangeError. This is an ordinary outcome of evaluating arbitrary user code
 * and must be surfaced as a normal tool error rather than silently ignored.
 */
export class EvaluateExpressionExceptionError extends Error {
  constructor(
    public readonly expression: string,
    public readonly exceptionType: string,
    public readonly exceptionMessage: string,
    public readonly exceptionStack?: string
  ) {
    super(`${exceptionType}: ${exceptionMessage}`);
    this.name = 'EvaluateExpressionExceptionError';
  }
}

/**
 * Thrown by evaluateExpression() when the underlying CDP call does not
 * return within the bounded client-side timeout. This is the backstop for
 * cases where the renderer/execution context stops responding entirely (no
 * result, no exception, no CDP-level timeout) - see the RangeError
 * stack-exhaustion hang this was written to fix.
 */
export class EvaluateExpressionTimeoutError extends Error {
  constructor(public readonly expression: string, public readonly timeoutMs: number) {
    super(`Evaluation timed out after ${timeoutMs}ms - the execution context may be unresponsive`);
    this.name = 'EvaluateExpressionTimeoutError';
  }
}

/**
 * Thrown by evaluateExpression() when the expression returned a Promise that
 * is still pending while the debugger is paused. The paused event loop can
 * never run the microtask queue, so the promise can never settle - awaiting
 * it would only burn the full client-side timeout. Failing fast with an
 * explanation is strictly better. (Promises that already settled - e.g.
 * `Promise.resolve(x)` or an async IIFE with no real await - ARE recovered
 * via their [[PromiseState]]/[[PromiseResult]] internal properties and never
 * reach this error.)
 */
export class EvaluateExpressionPendingPromiseError extends Error {
  constructor(public readonly expression: string) {
    super(
      'Expression returned a pending Promise while the debugger is paused - the event loop is stopped, so it can never settle'
    );
    this.name = 'EvaluateExpressionPendingPromiseError';
  }
}

/** Options accepted by evaluateExpression()/evaluateExpressionDetailed(). */
export interface EvaluateExpressionOptions {
  /**
   * Await a returned Promise and use its settled value (default: true).
   * Pass false to inspect the Promise object itself.
   */
  awaitPromise?: boolean;
  /**
   * Also attempt an exact, machine-readable capture of the result (via CDP
   * returnByValue on the result object - no re-execution, no display
   * round-trip). Only meaningful through evaluateExpressionDetailed().
   */
  captureRaw?: boolean;
}

/** Result of evaluateExpressionDetailed(). */
export interface EvaluateExpressionDetailedResult {
  /** Human-facing formatted value (same shape evaluateExpression() returns). */
  formatted: any;
  /** Exact value, only meaningful when rawCaptured is true. */
  rawValue?: unknown;
  /**
   * True when rawValue is an exact by-value capture of the result. False when
   * the value is not serializable by value (DOM node, Map, Date, window, ...)
   * - callers should fall back to reconstructing from `formatted`.
   */
  rawCaptured: boolean;
}

/** Truncate a long expression for inclusion in error messages/telemetry. */
function truncateExpression(expression: string, maxLength: number = 200): string {
  return expression.length > maxLength ? `${expression.slice(0, maxLength)}...` : expression;
}

export class CDPManager {
  /** Where this manager connected; empty until connect() succeeds. */
  private endpoint: { host: string; port: number } | null = null;

  private client: any = null;
  private state: DebuggerState = {
    connected: false,
    paused: false,
    breakpoints: new Map(),
  };
  private scriptIdToUrl: Map<string, string> = new Map();
  private urlToScriptId: Map<string, string[]> = new Map(); // Support multiple scripts per URL (inline HTML scripts)
  private pauseResolvers: Array<() => void> = [];
  /** Callers of resume() waiting for Chrome's Debugger.resumed event. */
  private resumeWaiters: Array<() => void> = [];
  /** A pause asked for while no JS ran: it fires on the next statement the page runs. */
  private pauseArmed = false;
  private scriptWaitResolvers: Array<{ pattern: string | RegExp; resolve: (url: string) => void }> = [];
  private sourceMapHandler: SourceMapHandler | null = null;
  private logpointLimitExceeded: {
    breakpointId: string;
    url: string;
    lineNumber: number;
    logMessage: string;
    executionCount: number;
    maxExecutions: number;
    logs: any[];
  } | null = null;
  private consoleMessageCallback: ConsoleMessageCallback | null = null;
  private pauseCallback: (() => void) | null = null;
  private resumeCallback: (() => void) | null = null;
  private pauseWatchers = new Set<(paused: boolean, event?: any) => void>();

  // DOMDebugger state for advanced breakpoints
  private domBreakpoints: Map<string, DOMBreakpointInfo> = new Map();
  private eventBreakpoints: Map<string, EventListenerBreakpointInfo> = new Map();
  private xhrBreakpoints: Map<string, XHRBreakpointInfo> = new Map();
  private advancedBpCounter = 0;

  constructor(sourceMapHandler?: SourceMapHandler) {
    this.sourceMapHandler = sourceMapHandler || null;
  }

  /**
   * Set a callback to receive console messages from Runtime.consoleAPICalled
   * This is used for Node.js debugging where Puppeteer's page.on('console') isn't available
   */
  setConsoleMessageCallback(callback: ConsoleMessageCallback | null): void {
    this.consoleMessageCallback = callback;
  }

  /**
   * Set a callback to be called when debugger pauses at a breakpoint
   */
  setPauseCallback(callback: (() => void) | null): void {
    this.pauseCallback = callback;
  }

  /**
   * Set a callback to be called when debugger resumes from a breakpoint
   */
  setResumeCallback(callback: (() => void) | null): void {
    this.resumeCallback = callback;
  }

  /** The URL a parsed script was loaded from; an inline script carries its page's URL. */
  scriptUrl(scriptId: string): string | undefined {
    return this.scriptIdToUrl.get(scriptId);
  }

  /** Receive every pause and resume of this connection's page, for as long as the returned stop is not called. */
  watchPause(watcher: (paused: boolean, event?: any) => void): () => void {
    this.pauseWatchers.add(watcher);
    return () => { this.pauseWatchers.delete(watcher); };
  }

  private notePause(paused: boolean, event?: any): void {
    for (const watcher of this.pauseWatchers) {
      try { watcher(paused, event); } catch { /* one watcher's failure leaves the others fed */ }
    }
  }

  /**
   * Find script IDs by URL, with fallback matching strategies:
   * 1. Exact match
   * 2. Base URL match (strips query params)
   * 3. Filename/path suffix match (e.g., "click.js" matches "/controls/click.js")
   *
   * This allows breakpoints to work with partial URLs and across page reloads
   * Returns the most recently loaded script (highest scriptId) when multiple matches exist
   */
  private findScriptIds(url: string): { scriptIds: string[]; matchedUrl: string } | null {
    // First, try exact match
    const exactMatch = this.urlToScriptId.get(url);
    if (exactMatch && exactMatch.length > 0) {
      return { scriptIds: exactMatch, matchedUrl: url };
    }

    // Second, try matching by base URL (strip query params)
    // If multiple matches, prefer the one with the highest scriptId (most recent)
    const baseUrl = url.split('?')[0];
    let bestMatch: { scriptIds: string[]; matchedUrl: string } | null = null;
    let highestScriptId = -1;

    for (const [loadedUrl, scriptIds] of this.urlToScriptId.entries()) {
      const loadedBaseUrl = loadedUrl.split('?')[0];
      if (loadedBaseUrl === baseUrl && scriptIds.length > 0) {
        // Get the highest numeric scriptId from this entry
        const maxId = Math.max(...scriptIds.map(id => parseInt(id, 10) || 0));
        if (maxId > highestScriptId) {
          highestScriptId = maxId;
          bestMatch = { scriptIds, matchedUrl: loadedUrl };
        }
      }
    }

    if (bestMatch) {
      return bestMatch;
    }

    // Third, a filename or path suffix at a path boundary: "click.js" and
    // "controls/click.js" match "http://localhost/controls/click.js", and
    // "click.js" does not match ".../doubleclick.js".
    const suffix = baseUrl.startsWith('/') ? baseUrl : '/' + baseUrl;
    for (const [loadedUrl, scriptIds] of this.urlToScriptId.entries()) {
      const loadedBaseUrl = loadedUrl.split('?')[0];
      if (loadedBaseUrl.endsWith(suffix)) {
        if (scriptIds.length > 0) {
          const maxId = Math.max(...scriptIds.map(id => parseInt(id, 10) || 0));
          if (maxId > highestScriptId) {
            highestScriptId = maxId;
            bestMatch = { scriptIds, matchedUrl: loadedUrl };
          }
        }
      }
    }

    return bestMatch;
  }

  /**
   * Check if a script with the given URL (or matching suffix) is loaded
   * This is useful to detect Vite-style serving where .ts files are loaded directly
   */
  isScriptLoaded(url: string): boolean {
    return this.findScriptIds(url) !== null;
  }

  /**
   * Get the URL for a script by its ID
   */
  getScriptUrl(scriptId: string): string | undefined {
    return this.scriptIdToUrl.get(scriptId);
  }

  /**
   * Connect to a Chrome or Node.js debugger instance
   * @param host - The debugger host (default: localhost)
   * @param port - The debugger port (default: 9222)
   * @param targetId - Optional target ID to connect to a specific page/tab
   */
  async connect(host: string = 'localhost', port: number = 9222, targetId?: string): Promise<void> {
    try {
      // If targetId is provided, connect to that specific target
      // Otherwise, connect to the default target
      const cdpOptions: any = { host, port };
      if (targetId) {
        cdpOptions.target = targetId;
      }
      this.client = await CDP(cdpOptions);
      // Held so a tool can reach sibling targets on the same browser - a worker
      // has its own target and its own websocket, and only host+port locates it.
      this.endpoint = { host, port };

      const { Debugger, Runtime, DOM } = this.client;

      // Set up event listeners BEFORE enabling domains
      // This ensures we capture scriptParsed events for already-loaded scripts
      // (which are emitted immediately when Debugger.enable() is called)
      Debugger.scriptParsed((params: any) => {
        this.scriptIdToUrl.set(params.scriptId, params.url);

        // Support multiple scripts per URL (inline HTML script blocks)
        const existingScripts = this.urlToScriptId.get(params.url) || [];
        this.urlToScriptId.set(params.url, [...existingScripts, params.scriptId]);

        // Register source map for lazy loading (loaded on-demand when needed)
        if (params.sourceMapURL && this.sourceMapHandler) {
          this.sourceMapHandler.registerSourceMap(params.url, params.sourceMapURL);
        }

        // Check if any waitForScript calls are waiting for this script
        const matchingResolvers: number[] = [];
        this.scriptWaitResolvers.forEach((waiter, index) => {
          const matches = typeof waiter.pattern === 'string'
            ? params.url.includes(waiter.pattern)
            : waiter.pattern.test(params.url);
          if (matches) {
            waiter.resolve(params.url);
            matchingResolvers.push(index);
          }
        });
        // Remove matched resolvers (in reverse order to maintain indices)
        matchingResolvers.reverse().forEach(index => {
          this.scriptWaitResolvers.splice(index, 1);
        });
      });

      Debugger.paused((params: any) => {
        // A pause devharness asked for on an idle page stops at the next script
        // the page runs, and devharness's own reads of the page - Puppeteer's,
        // named pptr:… - are page scripts too. Stopped in one, the read hangs
        // until the hold is released. Stepping out runs the read to its end
        // and stops at the next script after it, which is the app's.
        const top = params.callFrames?.[0];
        const where = top?.url || (top?.location?.scriptId ? this.scriptIdToUrl.get(top.location.scriptId) : '') || '';
        if (this.pauseArmed && OWN_SCRIPTS.test(where)) {
          debugLog('cdp-manager', `the armed pause landed in ${where}; stepping out of it`);
          void Debugger.stepOut().catch(() => {});
          return;
        }
        debugLog('cdp-manager', `Debugger.paused event received, resolvers count: ${this.pauseResolvers.length}`);
        this.state.paused = true;
        this.pauseArmed = false;
        this.state.currentCallFrames = params.callFrames;

        // Resolve all pending pause promises
        const resolvers = this.pauseResolvers.splice(0);
        debugLog('cdp-manager', `Resolving ${resolvers.length} pause resolvers`);
        resolvers.forEach(resolve => resolve());

        // A console line naming where it paused, 1-based as the breakpoint's own line is.
        if (params.callFrames && params.callFrames.length > 0) {
          const location = params.callFrames[0].location;
          const url = this.scriptIdToUrl.get(location.scriptId) || 'unknown';
          this.injectConsoleLink(url, location.lineNumber + 1, '⏸️ Paused at');
        }

        // Notify pause callback (e.g., to pause port monitoring)
        if (this.pauseCallback) {
          this.pauseCallback();
        }
        this.notePause(true, params);
      });

      Debugger.resumed(() => {
        this.state.paused = false;
        this.state.currentCallFrames = undefined;
        for (const resolve of this.resumeWaiters.splice(0)) resolve();

        // Notify resume callback (e.g., to resume port monitoring)
        if (this.resumeCallback) {
          this.resumeCallback();
        }
        this.notePause(false);
      });

      // Listen for breakpoint resolution - updates pending breakpoints when script loads
      Debugger.breakpointResolved((params: any) => {
        const { breakpointId, location } = params;
        const existingBp = this.state.breakpoints.get(breakpointId);
        if (existingBp && existingBp.status === 'pending') {
          // Update the breakpoint from pending to resolved
          existingBp.status = 'resolved';
          existingBp.location = location;
          this.state.breakpoints.set(breakpointId, existingBp);
        }
      });

      // Listen for console messages via CDP (works for both Chrome and Node.js)
      // This enables console capture for Node.js where Puppeteer isn't available
      Runtime.consoleAPICalled((params: CDPConsoleMessage) => {
        if (this.consoleMessageCallback) {
          this.consoleMessageCallback(params);
        }
      });

      // Enable domains AFTER setting up event listeners
      // This ensures we capture all events including scriptParsed for already-loaded scripts
      await Debugger.enable();
      await Runtime.enable();
      // Enable DOM domain (required for DOMDebugger breakpoints to work)
      // Note: DOM domain is not available in Node.js, only in browsers
      try {
        await DOM.enable();
      } catch {
        // DOM domain not available (e.g., Node.js runtime)
      }

      // Detect runtime type
      this.state.runtimeType = await this.detectRuntimeType();

      this.state.connected = true;
    } catch (error) {
      throw new Error(`Failed to connect to debugger: ${error}`);
    }
  }

  /**
   * Disconnect from the debugger
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      const wasPaused = this.state.paused;
      try {
        await this.client.close();
      } finally {
        this.client = null;
        this.state.connected = false;
        this.state.paused = false;
        this.state.currentCallFrames = undefined;
        this.state.runtimeType = undefined;
        this.state.breakpoints.clear();
        this.scriptIdToUrl.clear();
        this.urlToScriptId.clear();
        // Clear DOMDebugger state
        this.domBreakpoints.clear();
        this.eventBreakpoints.clear();
        this.xhrBreakpoints.clear();

        // A connection torn down while paused would otherwise never fire
        // Debugger.resumed, leaving anything gated on it (e.g. port monitoring)
        // stuck paused forever.
        if (wasPaused && this.resumeCallback) {
          this.resumeCallback();
        }
        if (wasPaused) this.notePause(false);
      }
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state.connected;
  }

  /**
   * Check if currently paused at a breakpoint
   */
  isPaused(): boolean {
    return this.state.paused;
  }

  /**
   * Get the runtime type (chrome, node, or unknown)
   */
  getRuntimeType(): RuntimeType {
    return this.state.runtimeType || 'unknown';
  }

  /**
   * Detect whether we're connected to Chrome/browser or Node.js
   * This detection happens by checking for browser-specific global objects
   */
  private async detectRuntimeType(): Promise<RuntimeType> {
    if (!this.client) {
      return 'unknown';
    }

    try {
      const { Runtime } = this.client;

      // Try to evaluate 'typeof window' - exists in browsers, not in Node.js
      const windowCheck = await Runtime.evaluate({
        expression: 'typeof window',
        silent: true,
      });

      // If 'window' is defined, we're in a browser (Chrome)
      if (windowCheck.result.type === 'object' ||
          windowCheck.result.value === 'object') {
        return 'chrome';
      }

      // Try to evaluate 'typeof process' - exists in Node.js, not in browsers
      const processCheck = await Runtime.evaluate({
        expression: 'typeof process',
        silent: true,
      });

      // If 'process' is an object, we're in Node.js
      if (processCheck.result.type === 'object' ||
          processCheck.result.value === 'object') {
        return 'node';
      }

      return 'unknown';
    } catch (error) {
      console.error('Failed to detect runtime type:', error);
      return 'unknown';
    }
  }

  /**
   * Set a breakpoint at a specific file and line
   */
  async setBreakpoint(url: string, lineNumber: number, columnNumber?: number, condition?: string): Promise<BreakpointInfo> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;

    // IMPORTANT: CDP uses 0-based line and column numbers internally
    // User provides 1-based numbers (line 1 = first line, column 1 = first column)
    // We must convert before calling CDP API
    const cdpLineNumber = lineNumber - 1;  // Convert 1-based → 0-based
    const cdpColumnNumber = columnNumber !== undefined ? columnNumber - 1 : undefined;  // Convert 1-based → 0-based

    // Try to find actual URL if the provided one has query params that may differ
    // This handles cache-busting params like ?v=123 that change on rebuild
    let actualUrl = url;
    const match = this.findScriptIds(url);
    if (match && match.matchedUrl !== url) {
      actualUrl = match.matchedUrl;
    }

    // Set breakpoint using 0-based CDP numbers
    let result;
    try {
      result = await Debugger.setBreakpointByUrl({
        url: actualUrl,
        lineNumber: cdpLineNumber,
        columnNumber: cdpColumnNumber,
        condition,
      });
    } catch (error: any) {
      // Handle "Breakpoint at specified location already exists" error
      if (error?.message?.includes('already exists')) {
        // Find and remove the existing breakpoint at this location
        for (const [bpId, bp] of this.state.breakpoints.entries()) {
          if (bp.originalLocation?.url === url &&
              bp.originalLocation?.lineNumber === lineNumber &&
              (columnNumber === undefined || bp.originalLocation?.columnNumber === columnNumber)) {
            await this.removeBreakpoint(bpId);
            break;
          }
        }
        // Retry setting the breakpoint
        result = await Debugger.setBreakpointByUrl({
          url: actualUrl,
          lineNumber: cdpLineNumber,
          columnNumber: cdpColumnNumber,
          condition,
        });
      } else {
        throw error;
      }
    }

    // Check if breakpoint was resolved to any location
    // Per CDP spec, setBreakpointByUrl can return empty locations if script isn't loaded yet
    // The breakpoint is still valid and will activate when the script loads
    if (!result.locations || result.locations.length === 0) {
      // Breakpoint is pending - script not loaded yet but breakpoint is queued
      const breakpointInfo: BreakpointInfo = {
        breakpointId: result.breakpointId,
        // For pending breakpoints, we don't have a resolved location yet
        // Use a placeholder that indicates pending state
        location: {
          scriptId: '',
          lineNumber: cdpLineNumber,  // Store the requested 0-based line
          columnNumber: cdpColumnNumber,
        },
        originalLocation: { url, lineNumber, columnNumber },
        status: 'pending',
      };

      this.state.breakpoints.set(result.breakpointId, breakpointInfo);
      return breakpointInfo;
    }

    // Warn if multiple locations (rare but possible)
    if (result.locations.length > 1) {
      console.error(`[devharness] Warning: Breakpoint matched ${result.locations.length} locations. Using first match.`);
    }

    // Store breakpoint info
    // - location: Actual location from CDP (0-based)
    // - originalLocation: User-requested location (1-based, what user asked for)
    const breakpointInfo: BreakpointInfo = {
      breakpointId: result.breakpointId,
      location: result.locations[0],
      originalLocation: { url, lineNumber, columnNumber },
      status: 'resolved',
    };

    this.state.breakpoints.set(result.breakpointId, breakpointInfo);
    return breakpointInfo;
  }

  /**
   * Remove a breakpoint
   */
  async removeBreakpoint(breakpointId: string): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    await Debugger.removeBreakpoint({ breakpointId });
    this.state.breakpoints.delete(breakpointId);
    // The limit refuses resume, and resetCounter cannot clear it once the logpoint is unregistered.
    if (this.logpointLimitExceeded?.breakpointId === breakpointId) {
      this.logpointLimitExceeded = null;
    }
  }

  /**
   * Get all active breakpoints
   */
  getBreakpoints(): BreakpointInfo[] {
    return Array.from(this.state.breakpoints.values());
  }

  /**
   * Get breakpoint counts (total, regular, logpoints)
   */
  getBreakpointCounts(): { total: number; breakpoints: number; logpoints: number } {
    const all = this.getBreakpoints();
    const logpoints = all.filter(bp => bp.isLogpoint).length;
    const regularBreakpoints = all.length - logpoints;

    return {
      total: all.length,
      breakpoints: regularBreakpoints,
      logpoints,
    };
  }

  /**
   * Wait for a script matching the given URL pattern to load
   * @param urlPattern - String (substring match) or RegExp to match against script URLs
   * @param timeout - Maximum time to wait in milliseconds (default: 10000)
   * @returns The URL of the matched script
   * @throws Error if timeout expires before script loads
   */
  async waitForScript(urlPattern: string | RegExp, timeout: number = 10000): Promise<string> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    // First, check if script is already loaded
    for (const url of this.urlToScriptId.keys()) {
      const matches = typeof urlPattern === 'string'
        ? url.includes(urlPattern)
        : urlPattern.test(url);
      if (matches) {
        return url;  // Script already loaded
      }
    }

    // Script not loaded yet, wait for it
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        // Remove this waiter from the list
        const index = this.scriptWaitResolvers.findIndex(w => w.resolve === resolveWrapper);
        if (index >= 0) {
          this.scriptWaitResolvers.splice(index, 1);
        }
        reject(new Error(`Timeout: Script matching "${urlPattern}" did not load within ${timeout}ms`));
      }, timeout);

      const resolveWrapper = (url: string) => {
        clearTimeout(timeoutId);
        resolve(url);
      };

      this.scriptWaitResolvers.push({
        pattern: urlPattern,
        resolve: resolveWrapper,
      });
    });
  }

  /**
   * Get list of all loaded scripts
   * @returns Array of script URLs
   */
  getLoadedScripts(): string[] {
    return Array.from(this.urlToScriptId.keys());
  }

  /**
   * Check if a script matching the pattern is loaded
   * @param urlPattern - String (substring match) or RegExp
   * @returns The matched URL or null
   */
  findLoadedScript(urlPattern: string | RegExp): string | null {
    for (const url of this.urlToScriptId.keys()) {
      const matches = typeof urlPattern === 'string'
        ? url.includes(urlPattern)
        : urlPattern.test(url);
      if (matches) {
        return url;
      }
    }
    return null;
  }

  /**
   * Resume execution
   */
  async resume(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    // Chrome acknowledges the command before its Debugger.resumed event can
    // arrive, and until that event the connection still reads as paused, so a
    // step run straight after a resume was refused as reading a paused page.
    // Bounded: a resumed event that never comes leaves the flag as it stands.
    const resumed = this.state.paused
      ? new Promise<void>(resolve => {
          this.resumeWaiters.push(resolve);
          setTimeout(resolve, 1000);
        })
      : Promise.resolve();
    await Debugger.resume();
    await resumed;
  }

  /**
   * Pause execution
   */
  async pause(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    if (!this.state.paused) this.pauseArmed = true;
    await Debugger.pause();
  }

  /**
   * Drop a pause that was asked for and never fired. Chrome has no command that
   * cancels it, and Debugger.resume refuses a page that is not paused, so the
   * armed pause would stop the next callback the page runs - long after the
   * hold that asked for it was released. One statement is run to fire it on,
   * and the page is resumed from there.
   */
  async disarmPause(): Promise<void> {
    if (!this.pauseArmed || this.state.paused || !this.state.connected) return;
    this.pauseArmed = false;
    const { Runtime } = this.client;
    const ran = Runtime.evaluate({ expression: '0' }).catch(() => {});
    await this.waitForPause(1000).catch(() => {});
    if (this.state.paused) await this.resume();
    await ran;
  }

  /**
   * Handle logpoint execution limit exceeded
   * This should be called by the LogpointExecutionTracker when a logpoint hits its limit
   */
  async handleLogpointLimitExceeded(metadata: {
    breakpointId: string;
    url: string;
    lineNumber: number;
    logMessage: string;
    executionCount: number;
    maxExecutions: number;
    logs: any[];
  }): Promise<void> {
    // The logpoint's own condition pauses the page on its line at this hit.
    this.logpointLimitExceeded = metadata;
  }

  /**
   * Get information about the logpoint that exceeded its limit (if any)
   */
  getLogpointLimitExceeded(): typeof this.logpointLimitExceeded {
    return this.logpointLimitExceeded;
  }

  /**
   * Clear the logpoint limit exceeded state
   */
  clearLogpointLimitExceeded(): void {
    this.logpointLimitExceeded = null;
  }

  /**
   * Step over (next line)
   */
  async stepOver(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    await Debugger.stepOver();
  }

  /**
   * Step into function
   */
  async stepInto(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    await Debugger.stepInto();
  }

  /**
   * Step out of function
   */
  async stepOut(): Promise<void> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;
    await Debugger.stepOut();
  }

  /**
   * Get current call stack
   */
  getCallStack(): CallFrame[] | undefined {
    if (!this.state.paused || !this.state.currentCallFrames) {
      return undefined;
    }

    return this.state.currentCallFrames.map((frame: any) => ({
      callFrameId: frame.callFrameId,
      functionName: frame.functionName || '(anonymous)',
      location: frame.location,
      url: this.scriptIdToUrl.get(frame.location.scriptId) || 'unknown',
      scopeChain: frame.scopeChain,
    }));
  }

  /**
   * Estimate token count for a value (rough approximation: ~4 chars per token)
   */
  private estimateTokens(value: any): number {
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return Math.ceil(str.length / 4);
  }

  /**
   * Calculate effective token budget accounting for response overhead.
   * The final MCP response includes:
   * - Message template text (~100 tokens)
   * - JSON code block markers and wrapper (~50 tokens)
   * - JSON.stringify indentation adds ~30% to data size
   */
  private calculateEffectiveBudget(maxTokens: number): number {
    const FIXED_OVERHEAD = 200; // Message template + code block + wrapper
    const PROPORTIONAL_OVERHEAD = 1.3; // JSON indentation adds ~30%
    return Math.floor((maxTokens - FIXED_OVERHEAD) / PROPORTIONAL_OVERHEAD);
  }

  /** The variables of one call frame's scopes, reduced to fit `maxTokens`. */
  async getVariables(
    callFrameId: string,
    includeGlobal: boolean = false,
    filter?: string,
    expandObjects: boolean = true,
    maxDepth: number = 2,
    maxTokens: number = 1000
  ): Promise<{
    data: any;
    totalCount: number;
    usedDepth: number;
    requestedDepth: number;
    responseType: 'full' | 'depth_reduced' | 'names_only' | 'counts_only';
    filterInsufficient: boolean;
  }> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Runtime } = this.client;
    const callFrame = this.state.currentCallFrames?.find(
      (frame: any) => frame.callFrameId === callFrameId
    );

    if (!callFrame) {
      throw new Error(`Call frame ${callFrameId} not found`);
    }

    let filterRegex: RegExp | null = null;
    if (filter) {
      try {
        filterRegex = new RegExp(filter, 'i');
      } catch {
        throw new Error(`Invalid filter regex: ${filter}`);
      }
    }
    const requestedDepth = maxDepth;

    // Collect property metadata first (without expanding)
    const propertyMeta: Array<{ prop: any; scopeType: string }> = [];

    for (const scope of callFrame.scopeChain) {
      if (scope.type === 'global' && !includeGlobal) {
        continue;
      }

      const properties = await Runtime.getProperties({
        objectId: scope.object.objectId,
        ownProperties: true,
      });

      for (const prop of properties.result) {
        if (!prop.value) continue;
        if (filterRegex && !filterRegex.test(prop.name)) continue;
        propertyMeta.push({ prop, scopeType: scope.type });
      }
    }

    const totalCount = propertyMeta.length;
    const effectiveBudget = this.calculateEffectiveBudget(maxTokens);
    const hasFilter = !!filter;

    // Helper to group variables by scope
    const groupByScope = (variables: any[]): Record<string, any[]> => {
      const grouped: Record<string, any[]> = {};
      for (const v of variables) {
        const scopeType = v.scopeType || 'unknown';
        if (!grouped[scopeType]) grouped[scopeType] = [];
        grouped[scopeType].push({ name: v.name, value: v.value, type: v.type });
      }
      return grouped;
    };

    // Helper to compute variables at a given depth
    const computeAtDepth = async (depth: number): Promise<{ variables: any[]; tokens: number }> => {
      const variables: any[] = [];
      const shouldExpand = expandObjects && depth > 0;
      for (const { prop, scopeType } of propertyMeta) {
        variables.push({
          name: prop.name,
          value: await this.formatValue(prop.value, shouldExpand, depth),
          type: prop.value.type,
          scopeType,
        });
      }
      return { variables, tokens: this.estimateTokens(variables) };
    };

    // Helper to get names-only data
    const getNamesOnly = (variables: any[]): Record<string, string[]> => {
      const namesByScope: Record<string, string[]> = {};
      for (const v of variables) {
        const scopeType = v.scopeType || 'unknown';
        if (!namesByScope[scopeType]) namesByScope[scopeType] = [];
        namesByScope[scopeType].push(v.name);
      }
      return namesByScope;
    };

    // Helper to get counts-only data
    const getCountsOnly = (variables: any[]): Record<string, number> => {
      const countsByScope: Record<string, number> = {};
      for (const v of variables) {
        const scopeType = v.scopeType || 'unknown';
        countsByScope[scopeType] = (countsByScope[scopeType] || 0) + 1;
      }
      return countsByScope;
    };

    // Step 1: Try full data at requested depth
    if (expandObjects && maxDepth > 0) {
      const requestedResult = await computeAtDepth(maxDepth);
      if (requestedResult.tokens <= effectiveBudget) {
        return {
          data: groupByScope(requestedResult.variables),
          totalCount,
          usedDepth: maxDepth,
          requestedDepth,
          responseType: 'full',
          filterInsufficient: false,
        };
      }
    }

    // Step 2: Try full data at depth 0
    const depth0Result = await computeAtDepth(0);
    if (depth0Result.tokens <= effectiveBudget) {
      // If we got here after trying requested depth, it means depth was reduced
      const wasDepthReduced = expandObjects && maxDepth > 0;
      return {
        data: groupByScope(depth0Result.variables),
        totalCount,
        usedDepth: 0,
        requestedDepth,
        responseType: wasDepthReduced ? 'depth_reduced' : 'full',
        filterInsufficient: false,
      };
    }

    // Step 3: Try names-only
    const namesOnly = getNamesOnly(depth0Result.variables);
    const namesTokens = this.estimateTokens(namesOnly);
    if (namesTokens <= effectiveBudget) {
      return {
        data: namesOnly,
        totalCount,
        usedDepth: 0,
        requestedDepth,
        responseType: 'names_only',
        filterInsufficient: hasFilter, // Filter was provided but still too large
      };
    }

    // Step 4: Fall back to counts-only (always fits)
    const countsOnly = getCountsOnly(depth0Result.variables);
    return {
      data: countsOnly,
      totalCount,
      usedDepth: 0,
      requestedDepth,
      responseType: 'counts_only',
      filterInsufficient: hasFilter,
    };
  }

  /**
   * How long evaluateExpression() waits for CDP to respond, in milliseconds.
   * The CDP client sets no timeout of its own, so without this a wedged target
   * holds the call forever. An instance property so tests can shorten it per
   * manager without real waits.
   */
  evaluateExpressionTimeoutMs: number = 10_000;

  /** The browser this manager is connected to, for reaching sibling targets. */
  getEndpoint(): { host: string; port: number } | null {
    return this.endpoint;
  }

  /**
   * Evaluate an expression in the current context.
   *
   * Two distinct failure modes are handled explicitly (this method used to
   * handle neither, which is how a stack-exhaustion RangeError thrown by
   * evaluated code could hang a caller forever with no result, no error, and
   * no timeout):
   *
   * 1. The evaluated code throws. CDP reports this via `exceptionDetails` on
   *    an otherwise-successful response - it is NOT a rejected promise - so
   *    it must be checked explicitly and surfaced as
   *    EvaluateExpressionExceptionError instead of being formatted as if it
   *    were a normal return value.
   * 2. The CDP call itself never resolves (a wedged renderer/execution
   *    context). A bounded client-side timeout (racing the CDP call against
   *    a timer) guarantees this method always settles, throwing
   *    EvaluateExpressionTimeoutError instead of hanging indefinitely. We
   *    also pass CDP's own `timeout` param so well-behaved renderers abort
   *    the runaway script themselves and return exceptionDetails cleanly
   *    (case 1) rather than relying solely on our client-side timer.
   */
  async evaluateExpression(
    expression: string,
    callFrameId?: string,
    expandObjects: boolean = true,
    maxDepth: number = 2,
    options?: EvaluateExpressionOptions
  ): Promise<any> {
    const detailed = await this.evaluateExpressionDetailed(
      expression,
      callFrameId,
      expandObjects,
      maxDepth,
      { ...options, captureRaw: false }
    );
    return detailed.formatted;
  }

  /**
   * Like evaluateExpression(), but also attempts an exact by-value capture of
   * the result when options.captureRaw is set (used for `saveAs` and the
   * structured `_meta.inspect.value`, so captured data does not round-trip
   * through display formatting).
   *
   * Promise handling (bug-015), all empirically verified against Chrome 150:
   * - Running page, no callFrameId: `awaitPromise: true` is passed to
   *   Runtime.evaluate, so async results resolve to their settled value and
   *   rejections surface as exceptionDetails (-> ExceptionError). A promise
   *   that never settles is bounded by the client-side timeout.
   * - Paused (callFrameId given, OR a global evaluation while the debugger is
   *   paused - Runtime.evaluate with awaitPromise HANGS in that state, and
   *   Debugger.evaluateOnCallFrame silently ignores awaitPromise): we never
   *   pass awaitPromise. Instead, a Promise result is resolved through its
   *   [[PromiseState]]/[[PromiseResult]] internal properties, which works
   *   without running the event loop: already-settled promises yield their
   *   exact value (or ExceptionError if rejected); a pending promise fails
   *   fast with EvaluateExpressionPendingPromiseError instead of burning the
   *   timeout, because it can never settle while the event loop is stopped.
   */
  async evaluateExpressionDetailed(
    expression: string,
    callFrameId?: string,
    expandObjects: boolean = true,
    maxDepth: number = 2,
    options?: EvaluateExpressionOptions
  ): Promise<EvaluateExpressionDetailedResult> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const awaitPromise = options?.awaitPromise !== false;
    const captureRaw = options?.captureRaw === true;

    const timeoutMs = this.evaluateExpressionTimeoutMs;
    // Leave CDP's own timeout slightly shorter than ours so a well-behaved
    // renderer's own abort (which yields a clean exceptionDetails response)
    // has a chance to win the race against our client-side backstop.
    const cdpTimeoutMs = Math.max(1000, timeoutMs - 1000);

    let timer: ReturnType<typeof setTimeout>;
    const timeoutGuard = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new EvaluateExpressionTimeoutError(truncateExpression(expression), timeoutMs)),
        timeoutMs
      );
    });

    // The whole pipeline (evaluate + promise recovery + formatting + raw
    // capture) runs inside the client-side timeout race: the follow-up CDP
    // calls talk to the same possibly-wedged target as the evaluation itself.
    const work = (async (): Promise<EvaluateExpressionDetailedResult> => {
      let result: { result: any; exceptionDetails?: any };
      if (callFrameId) {
        const { Debugger } = this.client;
        // awaitPromise is deliberately NOT passed: V8 ignores it on
        // evaluateOnCallFrame (verified), so it cannot be relied on.
        result = await Debugger.evaluateOnCallFrame({ callFrameId, expression, timeout: cdpTimeoutMs });
      } else {
        const { Runtime } = this.client;
        // awaitPromise while the debugger is paused hangs the CDP call
        // (event loop stopped -> promise can never settle), so only pass it
        // when the page is actually running.
        const canAwaitInProtocol = awaitPromise && !this.state.paused;
        result = await Runtime.evaluate({
          expression,
          timeout: cdpTimeoutMs,
          ...(canAwaitInProtocol ? { awaitPromise: true } : {}),
        });
      }

      if (result.exceptionDetails) {
        throw this.toEvaluateExpressionExceptionError(expression, result.exceptionDetails);
      }

      let remote = result.result;

      // Paused-context promise recovery (see doc comment above).
      if (awaitPromise && remote?.subtype === 'promise' && remote.objectId) {
        remote = await this.resolveSettledPromiseWhilePaused(expression, remote);
      }

      const formatted = await this.formatValue(remote, expandObjects, maxDepth);

      if (!captureRaw) {
        return { formatted, rawCaptured: false };
      }
      const capture = await this.captureRawValue(remote);
      return { formatted, ...capture };
    })();

    try {
      return await Promise.race([work, timeoutGuard]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /** Map CDP exceptionDetails to a typed error (thrown code or awaited promise rejection). */
  private toEvaluateExpressionExceptionError(
    expression: string,
    details: any
  ): EvaluateExpressionExceptionError {
    const exceptionObject = details.exception;
    const exceptionType = exceptionObject?.className || exceptionObject?.subtype || 'Error';
    // `description` on an Error RemoteObject is "Message\n    at stack...".
    // A promise rejected with a primitive has no description - the reason is
    // carried as exception.value (details.text is just "Uncaught (in promise)").
    const description: string | undefined = exceptionObject?.description;
    const exceptionMessage =
      description?.split('\n')[0] ||
      (exceptionObject && exceptionObject.value !== undefined ? String(exceptionObject.value) : undefined) ||
      details.text ||
      'Unknown error';
    const exceptionStack = description?.includes('\n') ? description : undefined;
    return new EvaluateExpressionExceptionError(
      truncateExpression(expression),
      exceptionType,
      exceptionMessage,
      exceptionStack
    );
  }

  /**
   * Resolve a Promise RemoteObject without running the event loop, via its
   * [[PromiseState]]/[[PromiseResult]] internal properties (readable even
   * while the debugger is paused). Returns the settled value's RemoteObject;
   * throws for rejected/pending promises.
   */
  private async resolveSettledPromiseWhilePaused(expression: string, promiseRemote: any): Promise<any> {
    const { Runtime } = this.client;
    const props = await Runtime.getProperties({ objectId: promiseRemote.objectId, ownProperties: true });
    const internal: any[] = props.internalProperties || [];
    const state = internal.find((p) => p.name === '[[PromiseState]]')?.value?.value;
    const resultRemote = internal.find((p) => p.name === '[[PromiseResult]]')?.value;

    if (state === 'fulfilled') {
      return resultRemote ?? { type: 'undefined' };
    }
    if (state === 'rejected') {
      const type = resultRemote?.className || resultRemote?.subtype || 'Error';
      const description: string | undefined = resultRemote?.description;
      const message =
        description?.split('\n')[0] ||
        (resultRemote && resultRemote.value !== undefined ? String(resultRemote.value) : 'Promise rejected');
      throw new EvaluateExpressionExceptionError(
        truncateExpression(expression),
        type,
        message,
        description?.includes('\n') ? description : undefined
      );
    }
    // pending (or internal props unavailable): it cannot settle while paused.
    throw new EvaluateExpressionPendingPromiseError(truncateExpression(expression));
  }

  /**
   * Attempt an exact by-value capture of an evaluation result, WITHOUT
   * re-executing the expression: primitives come straight off the
   * RemoteObject; plain objects/arrays are serialized in place via
   * Runtime.callFunctionOn(returnByValue). Values whose by-value form is
   * lossy or impossible (DOM nodes, Date, Map/Set, functions, window - CDP
   * serializes these to {} or errors) report rawCaptured: false so callers
   * can fall back to the display-derived reconstruction.
   */
  private async captureRawValue(remote: any): Promise<{ rawValue?: unknown; rawCaptured: boolean }> {
    if (!remote || remote.type === 'undefined') {
      return { rawValue: undefined, rawCaptured: true };
    }
    if (remote.type === 'string' || remote.type === 'number' || remote.type === 'boolean') {
      if ('value' in remote) {
        return { rawValue: remote.value, rawCaptured: true };
      }
      // Unserializable numbers (NaN, Infinity, -0) arrive as
      // unserializableValue with no `value` - let the caller fall back.
      return { rawCaptured: false };
    }
    if (remote.type === 'object') {
      if (remote.subtype === 'null') {
        return { rawValue: null, rawCaptured: true };
      }
      // Only plain JSON-like shapes serialize faithfully by value. Anything
      // with a specialized subtype/class (date, map, set, node, typedarray,
      // error, ...) collapses to {} under CDP's by-value serialization, which
      // is WORSE than the display-derived fallback.
      const className = remote.className;
      const jsonLike =
        (remote.subtype === undefined || remote.subtype === 'array') &&
        (className === undefined || className === 'Object' || className === 'Array');
      if (jsonLike && remote.objectId) {
        try {
          const { Runtime } = this.client;
          const cf = await Runtime.callFunctionOn({
            objectId: remote.objectId,
            functionDeclaration: 'function() { return this; }',
            returnByValue: true,
          });
          if (!cf.exceptionDetails) {
            return { rawValue: cf.result?.value, rawCaptured: true };
          }
        } catch {
          // Non-serializable (e.g. window: "Object reference chain is too
          // long") - fall through to the display-derived fallback.
        }
      }
    }
    return { rawCaptured: false };
  }

  /**
   * Validate logpoint expressions at a specific location
   * Sets temp breakpoint, waits for execution, tests expressions
   *
   * @param url File URL (e.g., http://localhost:3000/app.js)
   * @param lineNumber Line number (1-based, will be converted to 0-based for CDP)
   * @param columnNumber Optional column number (1-based, will be converted to 0-based for CDP)
   * @param expressions Array of expressions to validate (e.g., ["user.name", "user.id"])
   * @param timeout Max wait time for execution in milliseconds
   * @returns Validation results with pass/fail for each expression, plus available variables
   */
  async validateLogpointAtActualLocation(
    url: string,
    lineNumber: number,
    columnNumber: number | undefined,
    expressions: string[],
    timeout: number = 2000
  ): Promise<{
    executed: boolean;
    allValid: boolean;
    results: Array<{ expression: string; valid: boolean; value?: any; error?: string }>;
    availableVariables?: string[];
    actualLocation?: { line: number; column: number };  // 1-based for user display
  }> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    // Note: lineNumber and columnNumber are 1-based (user input)
    // setBreakpoint will convert them to 0-based for CDP
    const tempBreakpoint = await this.setBreakpoint(url, lineNumber, columnNumber);

    try {
      // Wait for execution with timeout
      await new Promise(resolve => setTimeout(resolve, timeout));

      // Check if we paused at the breakpoint
      if (!this.state.paused || !this.state.currentCallFrames) {
        // Code didn't execute - remove breakpoint and return
        await this.removeBreakpoint(tempBreakpoint.breakpointId);
        return {
          executed: false,
          allValid: false,
          results: expressions.map(expr => ({
            expression: expr,
            valid: false,
            error: 'Code has not executed yet - cannot validate without execution'
          })),
        };
      }

      // Get actual location from CDP (0-based)
      const actualLocation = tempBreakpoint.location;
      const actualLineUser = actualLocation.lineNumber + 1;  // Convert 0-based → 1-based
      const actualColumnUser = actualLocation.columnNumber !== undefined
        ? actualLocation.columnNumber + 1  // Convert 0-based → 1-based
        : undefined;

      // Get call frame for evaluation
      const callFrame = this.state.currentCallFrames[0];

      // Collect all available variables
      const { Runtime } = this.client;
      const availableVariables: string[] = [];

      for (const scope of callFrame.scopeChain) {
        if (scope.type === 'global') continue;  // Skip global

        const properties = await Runtime.getProperties({
          objectId: scope.object.objectId,
          ownProperties: true,
        });

        properties.result
          .filter((prop: any) => prop.value && !prop.name.startsWith('[['))
          .forEach((prop: any) => availableVariables.push(prop.name));
      }

      // Evaluate each expression
      const results: Array<{ expression: string; valid: boolean; value?: any; error?: string }> = [];

      for (const expr of expressions) {
        try {
          const value = await this.evaluateExpression(expr, callFrame.callFrameId);
          results.push({
            expression: expr,
            valid: true,
            value,
          });
        } catch (error) {
          results.push({
            expression: expr,
            valid: false,
            error: String(error),
          });
        }
      }

      // Resume execution
      await this.resume();

      // Remove temp breakpoint
      await this.removeBreakpoint(tempBreakpoint.breakpointId);

      const allValid = results.every(r => r.valid);

      return {
        executed: true,
        allValid,
        results,
        availableVariables: [...new Set(availableVariables)],  // Deduplicate
        actualLocation: {
          line: actualLineUser,
          column: actualColumnUser!,
        },
      };
    } catch (error) {
      // Clean up on error
      try {
        if (this.state.paused) {
          await this.resume();
        }
        await this.removeBreakpoint(tempBreakpoint.breakpointId);
      } catch (e) {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Search for the best location to set a logpoint by trying nearby lines/columns
   * Returns suggestions ranked by how many expressions are valid
   *
   * @param url File URL
   * @param lineNumber Desired line number (1-based)
   * @param columnNumber Desired column number (1-based, optional)
   * @param expressions Array of expressions to validate
   * @param searchRadius Number of lines to search in each direction (default: 2)
   * @param timeout Timeout per location test in milliseconds (default: 1000ms)
   * @returns Array of suggestions sorted by score (best first), max 3 results
   */
  async findBestLogpointLocation(
    url: string,
    lineNumber: number,
    columnNumber: number | undefined,
    expressions: string[],
    searchRadius: number = 2,
    timeout: number = 1000
  ): Promise<Array<{
    line: number;
    column: number | undefined;
    score: number;
    validExpressions: string[];
    invalidExpressions: string[];
    availableVariables: string[];
    reason: string;
  }>> {
    const candidates: Array<{
      line: number;
      column: number | undefined;
      score: number;
      validExpressions: string[];
      invalidExpressions: string[];
      availableVariables: string[];
      reason: string;
    }> = [];

    // Try requested line first, then ±1, ±2, etc.
    for (let offset = 0; offset <= searchRadius; offset++) {
      const lines = offset === 0 ? [lineNumber] : [lineNumber - offset, lineNumber + offset];

      for (const line of lines) {
        if (line < 1) continue;  // Skip negative lines

        try {
          const validation = await this.validateLogpointAtActualLocation(
            url,
            line,
            columnNumber,
            expressions,
            timeout
          );

          if (validation.executed) {
            const validCount = validation.results.filter(r => r.valid).length;
            const score = Math.round((validCount / expressions.length) * 100);

            candidates.push({
              line: validation.actualLocation?.line || line,
              column: validation.actualLocation?.column,
              score,
              validExpressions: validation.results.filter(r => r.valid).map(r => r.expression),
              invalidExpressions: validation.results.filter(r => !r.valid).map(r => r.expression),
              availableVariables: validation.availableVariables || [],
              reason: score === 100 ? 'All expressions available in scope' :
                      score > 0 ? `${validCount}/${expressions.length} expressions available` :
                      'No expressions available'
            });
          }
        } catch (e) {
          // Skip locations that error
          continue;
        }
      }
    }

    // Sort by score (highest first), then by proximity to original line
    candidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;  // Higher score first
      }
      // If scores equal, prefer closer to original line
      return Math.abs(a.line - lineNumber) - Math.abs(b.line - lineNumber);
    });

    // Return top 3
    return candidates.slice(0, 3);
  }

  /**
   * Get source code from a file at a specific line range
   */
  async getSourceCode(
    url: string,
    startLine?: number,
    endLine?: number
  ): Promise<{ code: string; totalLines: number; hasSourceMap: boolean; startLine: number; endLine: number }> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;

    // Find the script IDs for this URL (with fallback matching for partial URLs)
    const match = this.findScriptIds(url);
    if (!match) {
      throw new Error(`Script not found for URL: ${url}. Make sure the script has been loaded/parsed.`);
    }
    const scriptIds = match.scriptIds;

    // If multiple scripts, find the one containing the requested line range
    let scriptId: string;
    let fullSource: string;
    let totalLines: number;

    if (scriptIds.length === 1) {
      // Only one script - use it
      scriptId = scriptIds[0];
      const result = await Debugger.getScriptSource({ scriptId });
      fullSource = result.scriptSource;
      totalLines = fullSource.split('\n').length;
    } else {
      // Multiple scripts - find the one containing the requested line
      const targetLine = startLine || 1;
      let found = false;

      for (const sid of scriptIds) {
        const result = await Debugger.getScriptSource({ scriptId: sid });
        const source = result.scriptSource;
        const lineCount = source.split('\n').length;

        // Check if this script contains the requested line
        if (targetLine <= lineCount) {
          scriptId = sid;
          fullSource = source;
          totalLines = lineCount;
          found = true;
          break;
        }
      }

      if (!found) {
        throw new Error(`Line ${targetLine} not found in any script for URL: ${url}. This URL has ${scriptIds.length} inline scripts.`);
      }
    }

    // Split into lines
    const lines = fullSource!.split('\n');

    // Determine the range
    const start = startLine ? Math.max(1, startLine) : 1;
    const end = endLine ? Math.min(totalLines!, endLine) : (startLine ? Math.min(totalLines!, startLine + 9) : totalLines!);
    if (start > totalLines!) {
      throw new Error(`Line ${start} is past the end of ${url}, which has ${totalLines!} lines`);
    }

    // Extract the requested lines (convert to 0-indexed)
    const extractedLines = lines.slice(start - 1, end);

    // Format with line numbers, truncating source map lines
    const formattedCode = extractedLines
      .map((line: string, index: number) => {
        const lineNum = start + index;
        let displayLine = line;

        // Detect and truncate inline source maps (they can be huge)
        if (line.startsWith('//# sourceMappingURL=data:')) {
          const truncateAt = 60;
          displayLine = line.substring(0, truncateAt) + `... [source map truncated, ${Math.round(line.length / 1024)}kb]`;
        }

        return `${String(lineNum).padStart(4, ' ')} | ${displayLine}`;
      })
      .join('\n');

    // Check if source map is available
    const hasSourceMap = this.sourceMapHandler?.hasSourceMap(url) || false;

    return {
      code: formattedCode,
      totalLines: totalLines!,
      hasSourceMap,
      startLine: start,
      endLine: end,
    };
  }

  /**
   * Log `message` and `url:lineNumber` to the page's console, which DevTools
   * renders as a link to that line.
   */
  async injectConsoleLink(url: string, lineNumber: number, message: string): Promise<void> {
    if (!this.state.connected) {
      return;
    }

    const { Runtime } = this.client;

    // As JSON string literals, so a quote in the URL or message stays inside its string.
    const consoleExpression = `console.log(${JSON.stringify(`${message} %c${url}:${lineNumber}`)}, ${JSON.stringify('color: #0066cc; text-decoration: underline; cursor: pointer; font-weight: bold')});`;

    // Sent without waiting: a pause requested on an idle page stops at this
    // evaluation, which then answers only once the page resumes.
    Runtime.evaluate({ expression: consoleExpression }).catch(() => {});
  }

  /**
   * Get detailed information about current pause state
   */
  getPausedInfo(): { paused: boolean; location?: any; callStack?: CallFrame[] } {
    if (!this.state.paused) {
      return { paused: false };
    }

    // 1-based, as every reply shows a location; Chrome's frames are 0-based.
    const callStack = this.getCallStack();
    const location = callStack && callStack.length > 0 ? {
      url: callStack[0].url,
      lineNumber: callStack[0].location.lineNumber + 1,
      columnNumber: callStack[0].location.columnNumber !== undefined ? callStack[0].location.columnNumber + 1 : undefined,
      functionName: callStack[0].functionName,
    } : undefined;

    return {
      paused: true,
      location,
      callStack,
    };
  }

  /**
   * Wait for debugger to pause (for race detection)
   * Returns a promise that resolves when debugger pauses, or rejects on timeout
   */
  waitForPause(timeoutMs: number = 30000): Promise<void> {
    debugLog('cdp-manager', `waitForPause called, already paused: ${this.state.paused}, timeout: ${timeoutMs}ms`);
    if (this.state.paused) {
      debugLog('cdp-manager', 'waitForPause: already paused, resolving immediately');
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      let resolved = false;

      const wrappedResolve = () => {
        if (resolved) return;
        resolved = true;
        debugLog('cdp-manager', 'waitForPause: wrappedResolve called, resolving promise');
        clearTimeout(timeout);
        resolve();
      };

      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        debugLog('cdp-manager', `waitForPause: timeout after ${timeoutMs}ms, state.paused=${this.state.paused}`);
        // Remove resolver from list
        const index = this.pauseResolvers.indexOf(wrappedResolve);
        if (index > -1) {
          this.pauseResolvers.splice(index, 1);
        }
        reject(new Error('Timeout waiting for pause'));
      }, timeoutMs);

      this.pauseResolvers.push(wrappedResolve);
      debugLog('cdp-manager', `waitForPause: resolver added, total resolvers: ${this.pauseResolvers.length}`);

      // Re-check after adding resolver to handle race condition
      // where pause happened between initial check and push
      if (this.state.paused) {
        debugLog('cdp-manager', 'waitForPause: paused detected after adding resolver, resolving');
        wrappedResolve();
      }
    });
  }

  /**
   * Format a CDP RemoteObject value for display
   * @param value The CDP RemoteObject to format
   * @param expandObjects Whether to expand object/array contents (default: false for backward compatibility)
   * @param maxDepth Maximum depth for object expansion (default: 2)
   * @param currentDepth Current recursion depth (internal use)
   */
  private async formatValue(
    value: any,
    expandObjects: boolean = false,
    maxDepth: number = 2,
    currentDepth: number = 0
  ): Promise<any> {
    if (value.type === 'undefined') return 'undefined';
    if (value.type === 'string') return `"${value.value}"`;
    if (value.type === 'number' || value.type === 'boolean') return String(value.value);
    if (value.type === 'object') {
      if (value.subtype === 'null') return 'null';

      // Detect and handle DOM nodes specially (never expand)
      const className = value.className || '';
      if (className.startsWith('HTML') || className.includes('Element') || value.subtype === 'node') {
        return `[${className || 'DOMNode'}]`;
      }

      // If expansion is disabled or we've hit max depth, return description
      if (!expandObjects || currentDepth >= maxDepth) {
        if (value.subtype === 'array') return value.description || 'Array';
        return value.description || value.className || 'Object';
      }

      // Expand object/array contents with smart size limits
      if (value.objectId) {
        try {
          const { Runtime } = this.client;
          const properties = await Runtime.getProperties({
            objectId: value.objectId,
            ownProperties: true,
          });

          if (value.subtype === 'array') {
            // Smart array handling based on size
            const numericProps = properties.result.filter((p: any) => !isNaN(parseInt(p.name, 10)));
            const arrayLength = numericProps.length;

            // For large arrays, truncate to first 10 elements
            if (arrayLength > 20) {
              const arrayElements: any[] = [];
              let itemsShown = 0;
              for (const prop of numericProps.slice(0, 10)) {
                const index = parseInt(prop.name, 10);
                if (prop.value) {
                  arrayElements[index] = await this.formatValue(
                    prop.value,
                    expandObjects,
                    maxDepth,
                    currentDepth + 1
                  );
                  itemsShown++;
                }
              }
              // Add truncation indicator
              arrayElements.push(`... ${arrayLength - itemsShown} more items (inspect action evaluateExpression reads the rest)`);
              return arrayElements;
            }

            // Small arrays - show all elements
            const arrayElements: any[] = [];
            for (const prop of properties.result) {
              const index = parseInt(prop.name, 10);
              if (!isNaN(index) && prop.value) {
                arrayElements[index] = await this.formatValue(
                  prop.value,
                  expandObjects,
                  maxDepth,
                  currentDepth + 1
                );
              }
            }
            return arrayElements;
          } else {
            // Smart object handling based on property count
            const validProps = properties.result.filter((p: any) => p.value && !p.name.startsWith('[['));
            const propCount = validProps.length;

            // For very large objects, show summary with first few keys
            if (propCount > 50) {
              const firstKeys = validProps.slice(0, 5).map((p: any) => p.name);
              return `[Object with ${propCount} properties] {${firstKeys.join(', ')}, ...} - inspect action evaluateExpression reads the rest`;
            }

            // For moderately large objects (10-50 props), limit depth
            if (propCount > 10 && currentDepth > 0) {
              const firstKeys = validProps.slice(0, 10).map((p: any) => p.name);
              return `[Object with ${propCount} properties] {${firstKeys.join(', ')}${propCount > 10 ? ', ...' : ''}}`;
            }

            // Small objects - expand normally
            const objectProps: Record<string, any> = {};
            for (const prop of validProps) {
              objectProps[prop.name] = await this.formatValue(
                prop.value,
                expandObjects,
                maxDepth,
                currentDepth + 1
              );
            }
            return objectProps;
          }
        } catch (error) {
          // If expansion fails, fall back to description
          if (value.subtype === 'array') return value.description || 'Array';
          return value.description || value.className || 'Object';
        }
      }

      // No objectId, can't expand
      if (value.subtype === 'array') return value.description || 'Array';
      return value.description || value.className || 'Object';
    }
    if (value.type === 'function') {
      // Extract just the function name/signature, not the full source
      const desc = value.description || '';
      const match = desc.match(/^(function\s+\w+|async\s+function\s+\w+|\w+)\s*\(/);
      if (match) {
        return `[Function: ${match[1]}]`;
      }
      return '[Function]';
    }
    return String(value.value);
  }

  /**
   * Expand a CDP RemoteObject by its objectId
   * This is used to get full object details for console messages
   * @param objectId - The CDP object ID to expand
   * @param maxDepth - Maximum depth for nested object expansion (default: 2)
   */
  async expandObjectById(objectId: string, maxDepth: number = 2): Promise<any> {
    if (!this.state.connected || !this.client) {
      throw new Error('Not connected to debugger');
    }

    const { Runtime } = this.client;

    // Get the object properties
    const properties = await Runtime.getProperties({
      objectId,
      ownProperties: true,
    });

    // Build the expanded object
    const result: Record<string, any> = {};
    const validProps = properties.result.filter((p: any) => p.value && !p.name.startsWith('[['));

    for (const prop of validProps.slice(0, 20)) { // Limit to 20 properties for console output
      result[prop.name] = await this.formatValue(prop.value, true, maxDepth, 0);
    }

    if (validProps.length > 20) {
      result['...'] = `(${validProps.length - 20} more properties)`;
    }

    return result;
  }

  /**
   * Get all loaded scripts
   */
  getAllScripts(): Array<{ scriptId: string; url: string }> {
    return Array.from(this.scriptIdToUrl.entries()).map(([scriptId, url]) => ({
      scriptId,
      url,
    }));
  }

  /**
   * Search within a specific script using regex
   */
  async searchInScript(
    scriptId: string,
    pattern: string,
    caseSensitive: boolean = false,
    isRegex: boolean = true
  ): Promise<Array<{ lineNumber: number; lineContent: string }>> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { Debugger } = this.client;

    try {
      const result = await Debugger.searchInContent({
        scriptId,
        query: pattern,
        caseSensitive,
        isRegex,
      });

      return (result.result || []).map((match: any) => ({
        lineNumber: match.lineNumber,
        lineContent: match.lineContent,
      }));
    } catch (error) {
      // Script might not support search or other error
      return [];
    }
  }

  /**
   * Get a specific line from a script by scriptId and line number
   * Returns the full line content (useful for getting full webpack eval lines)
   */
  async getScriptLine(scriptId: string, lineNumber: number): Promise<string | null> {
    if (!this.state.connected) {
      return null;
    }

    const { Debugger } = this.client;

    try {
      const result = await Debugger.getScriptSource({ scriptId });
      const lines = result.scriptSource.split('\n');
      // lineNumber is 0-indexed from searchInContent
      if (lineNumber >= 0 && lineNumber < lines.length) {
        return lines[lineNumber];
      }
      return null;
    } catch (error) {
      return null;
    }
  }

  // ============================================
  // DOMDebugger Methods (DOM/Event/XHR Breakpoints)
  // ============================================

  /**
   * Generate a unique ID for advanced breakpoints
   */
  private generateAdvancedBpId(prefix: string): string {
    return `${prefix}-${++this.advancedBpCounter}`;
  }

  /**
   * Resolve a CSS selector to a CDP nodeId
   * @param selector - CSS selector to resolve
   * @returns nodeId for the element
   */
  async resolveSelector(selector: string): Promise<number> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { DOM } = this.client;

    // Get document root
    const { root } = await DOM.getDocument();

    // Query selector to get nodeId
    const { nodeId } = await DOM.querySelector({
      nodeId: root.nodeId,
      selector,
    });

    if (!nodeId || nodeId === 0) {
      throw new Error(`Element not found: ${selector}`);
    }

    return nodeId;
  }

  /**
   * Set a DOM breakpoint on a node
   * Pauses execution when the specified DOM mutation occurs
   * @param nodeId - The node ID from resolveSelector
   * @param type - Type of DOM change to break on
   * @param selector - Original CSS selector (for reference/display)
   */
  async setDOMBreakpoint(
    nodeId: number,
    type: DOMBreakpointType,
    selector: string
  ): Promise<DOMBreakpointInfo> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { DOMDebugger } = this.client;

    await DOMDebugger.setDOMBreakpoint({ nodeId, type });

    const id = this.generateAdvancedBpId('dom-bp');
    const info: DOMBreakpointInfo = {
      breakpointId: id,
      type: 'dom',
      nodeId,
      domBreakpointType: type,
      selector,
    };

    this.domBreakpoints.set(id, info);
    return info;
  }

  /**
   * Remove a DOM breakpoint by its ID
   */
  async removeDOMBreakpoint(breakpointId: string): Promise<void> {
    const bp = this.domBreakpoints.get(breakpointId);
    if (!bp) {
      throw new Error(`DOM breakpoint not found: ${breakpointId}`);
    }

    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { DOMDebugger } = this.client;

    await DOMDebugger.removeDOMBreakpoint({
      nodeId: bp.nodeId,
      type: bp.domBreakpointType,
    });

    this.domBreakpoints.delete(breakpointId);
  }

  /**
   * Get all DOM breakpoints
   */
  getDOMBreakpoints(): DOMBreakpointInfo[] {
    return Array.from(this.domBreakpoints.values());
  }

  /**
   * Set an event listener breakpoint
   * Pauses execution when the specified event fires
   * @param eventName - DOM event name (e.g., 'click', 'submit', 'input')
   * @param targetName - Optional EventTarget interface filter (e.g., 'HTMLInputElement')
   */
  async setEventListenerBreakpoint(
    eventName: string,
    targetName?: string
  ): Promise<EventListenerBreakpointInfo> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { DOMDebugger } = this.client;

    await DOMDebugger.setEventListenerBreakpoint({ eventName, targetName });

    const id = this.generateAdvancedBpId('event-bp');
    const info: EventListenerBreakpointInfo = {
      breakpointId: id,
      type: 'event',
      eventName,
      targetName,
    };

    this.eventBreakpoints.set(id, info);
    return info;
  }

  /**
   * Remove an event listener breakpoint by its ID
   */
  async removeEventListenerBreakpoint(breakpointId: string): Promise<void> {
    const bp = this.eventBreakpoints.get(breakpointId);
    if (!bp) {
      throw new Error(`Event listener breakpoint not found: ${breakpointId}`);
    }

    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { DOMDebugger } = this.client;

    await DOMDebugger.removeEventListenerBreakpoint({
      eventName: bp.eventName,
      targetName: bp.targetName,
    });

    this.eventBreakpoints.delete(breakpointId);
  }

  /**
   * Get all event listener breakpoints
   */
  getEventListenerBreakpoints(): EventListenerBreakpointInfo[] {
    return Array.from(this.eventBreakpoints.values());
  }

  /**
   * Set an XHR/Fetch breakpoint
   * Pauses execution when an XHR or Fetch request URL contains the pattern
   * @param urlPattern - URL substring to match
   */
  async setXHRBreakpoint(urlPattern: string): Promise<XHRBreakpointInfo> {
    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { DOMDebugger } = this.client;

    await DOMDebugger.setXHRBreakpoint({ url: urlPattern });

    const id = this.generateAdvancedBpId('xhr-bp');
    const info: XHRBreakpointInfo = {
      breakpointId: id,
      type: 'xhr',
      urlPattern,
    };

    this.xhrBreakpoints.set(id, info);
    return info;
  }

  /**
   * Remove an XHR/Fetch breakpoint by its ID
   */
  async removeXHRBreakpoint(breakpointId: string): Promise<void> {
    const bp = this.xhrBreakpoints.get(breakpointId);
    if (!bp) {
      throw new Error(`XHR breakpoint not found: ${breakpointId}`);
    }

    if (!this.state.connected) {
      throw new Error('Not connected to debugger');
    }

    const { DOMDebugger } = this.client;

    await DOMDebugger.removeXHRBreakpoint({ url: bp.urlPattern });

    this.xhrBreakpoints.delete(breakpointId);
  }

  /**
   * Get all XHR/Fetch breakpoints
   */
  getXHRBreakpoints(): XHRBreakpointInfo[] {
    return Array.from(this.xhrBreakpoints.values());
  }
}
