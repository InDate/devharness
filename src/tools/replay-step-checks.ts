/**
 * The reads a replay run makes around its steps: whether the debugger is
 * paused, launching or reaching the run's browser, whether a navigation, a
 * typed value or a click did what the step intended, and the page state a
 * failed step reports.
 */

import type { StepTraffic } from '../annotation.js';
import type { CommandSequence } from '../command-recorder.js';
import type { ExecuteToolCall } from '../types.js';
import type { ClickValidationConfig } from '../config.js';
import type { ClickActionMeta, DebuggerStatusMeta } from '../tool-response.js';
import { compareFingerprints, describeFingerprint, locateFingerprint, type ElementFingerprint, type ElementRepair } from '../element-fingerprint.js';
import { unlisted } from '../call-origin.js';
import { debugLog } from '../debug-logger.js';
import { requireValidReference } from '../reference-validator.js';
import { checkUrlPort } from '../utils/port-check.js';
import type { BreakpointHitInfo, ConnectionAnalysis, ExecutionContext } from './replay-types.js';

/**
 * The debugger's state on the context's connection, read from
 * `connection status`'s `_meta`. That call answers the same way paused or
 * running, so a run that is not paused makes no failed call to learn it.
 * Undefined when the connection cannot be read.
 */
export async function debuggerStatusOf(ctx: ExecutionContext): Promise<DebuggerStatusMeta | undefined> {
  const { executeToolCall, connection } = ctx;
  if (!connection) return undefined;
  try {
    const result = await executeToolCall('connection', { action: 'status', connection });
    return result?._meta?.debugger;
  } catch {
    return undefined;
  }
}

/**
 * Where the debugger is paused, or null while it runs.
 */
export async function checkIfPaused(
  ctx: ExecutionContext
): Promise<BreakpointHitInfo | null> {
  const status = await debuggerStatusOf(ctx);
  if (!status?.paused) return null;
  const at = status.pausedAt;
  return at
    ? {
        url: at.url,
        lineNumber: at.lineNumber,
        ...(at.columnNumber !== undefined ? { columnNumber: at.columnNumber } : {}),
        ...(at.functionName ? { functionName: at.functionName } : {}),
      }
    : { url: 'unknown', lineNumber: 0 };
}

/**
 * Check if debugger is paused and auto-resume if so
 */
export async function resumeIfPaused(
  ctx: ExecutionContext
): Promise<void> {
  const { executeToolCall, connection, logPrefix = 'executor' } = ctx;

  if (!connection) return;

  const pauseInfo = await checkIfPaused(ctx);
  if (pauseInfo) {
    debugLog(logPrefix, `Debugger is paused at ${pauseInfo.url}:${pauseInfo.lineNumber}, auto-resuming`);
    try {
      await executeToolCall('execution', {
        action: 'resume',
        connection
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      // Ignore resume errors
    }
  }
}

// =============================================================================
// Auto-Launch Helper
// =============================================================================

export type AutoLaunchResult = {
  success: true;
} | {
  success: false;
  error: string;
  errorType: 'INVALID_REFERENCE' | 'LAUNCH_FAILED';
};

/**
 * Validate reference and auto-launch Chrome if needed.
 * This is the shared helper for all auto-launch scenarios.
 */
export async function autoLaunchChrome(
  executeToolCall: ExecuteToolCall,
  connection: string,
  logPrefix: string = 'auto-launch',
  forceNewInstance: boolean = false,
  proxy: boolean = false
): Promise<AutoLaunchResult> {
  // Answered as a result rather than thrown: this runs inside ensureConnection's
  // catch, where a throw escapes the run's own LAUNCH_FAILED handling.
  try {
    requireValidReference(connection, 'connection');
  } catch (invalid: any) {
    return {
      success: false,
      error: invalid?.response?.content?.[0]?.text || invalid?.message || `Invalid connection name "${connection}"`,
      errorType: 'INVALID_REFERENCE',
    };
  }

  await debugLog(logPrefix, `Auto-launching Chrome with reference: ${connection} (forceNewInstance=${forceNewInstance})`);

  // A launch failure arrives as a throw (executeToolCall raises isError), and
  // is answered as LAUNCH_FAILED for the same reason.
  try {
    await executeToolCall('connection', {
      action: 'launch',
      connection,
      forceNewInstance,
      ...(proxy && { proxy: true }),
    });
  } catch (launchError: any) {
    return {
      success: false,
      error: `Failed to auto-launch Chrome: ${launchError?.response?.content?.[0]?.text || launchError?.message || 'Unknown error'}`,
      errorType: 'LAUNCH_FAILED'
    };
  }

  await debugLog(logPrefix, `Chrome launched successfully with reference: ${connection}`);
  return { success: true };
}

/**
 * Ensure a connection is available, auto-launching Chrome if needed
 */
export async function ensureConnection(
  ctx: ExecutionContext,
  needsConnection: boolean,
  createsBeforeUse: boolean,
  /** The recording ran through a proxy, so the browser this launches needs one
   *  too - otherwise the replay drives an app whose traffic nothing captures. */
  throughProxy: boolean = false
): Promise<{ success: true; didAutoLaunch: boolean } | { success: false; error: string }> {
  const { executeToolCall, connection, logPrefix = 'executor' } = ctx;

  if (!needsConnection || createsBeforeUse) {
    return { success: true, didAutoLaunch: false };
  }

  try {
    await debugLog(logPrefix, `Checking connection: ${connection}`);
    const infoResult = await executeToolCall('navigate', { action: 'info', connection });
    // In production this throws instead, into the same catch below; the check
    // is for a caller wired not to rethrow.
    if (infoResult?.isError) {
      throw new Error('Connection not active');
    }
    await debugLog(logPrefix, `Connection ${connection} is active`);

    // Auto-resume if paused at a breakpoint
    await resumeIfPaused(ctx);

    return { success: true, didAutoLaunch: false };
  } catch {
    await debugLog(logPrefix, `Connection ${connection} not active, launching Chrome...`);
    // Sequence runs always get a fresh Chrome process, not a tab in an existing one
    const launchResult = await autoLaunchChrome(executeToolCall, connection, logPrefix, true, throughProxy);
    if (!launchResult.success) {
      return { success: false, error: launchResult.error };
    }
    return { success: true, didAutoLaunch: true };
  }
}

/**
 * Check if a URL's port is open (for localhost URLs only)
 * Returns success if port is open or URL is not localhost
 */
export async function checkPortBeforeNavigation(
  url: string,
  logPrefix: string = 'executor'
): Promise<{ success: true } | { success: false; error: string }> {
  const portCheck = await checkUrlPort(url, 2000);

  // null means non-localhost URL - skip check
  if (portCheck === null) {
    return { success: true };
  }

  if (!portCheck.open) {
    const error = `Port ${portCheck.port} is not open on ${portCheck.host}`;
    await debugLog(logPrefix, error);
    return { success: false, error };
  }

  await debugLog(logPrefix, `Port ${portCheck.port} is open on ${portCheck.host}`);
  return { success: true };
}

/**
 * Navigate to startUrl if sequence has one and doesn't start with navigate
 */
export async function navigateToStartUrl(
  ctx: ExecutionContext,
  sequence: CommandSequence,
  analysis: ConnectionAnalysis
): Promise<{ success: true } | { success: false; error: string }> {
  const { executeToolCall, connection, logPrefix = 'executor' } = ctx;

  if (!sequence.startUrl || !connection) {
    return { success: true };
  }

  const commands = sequence.commands;
  const firstNavigateIndex = commands.findIndex(cmd =>
    cmd.tool === 'navigate' && cmd.params.action === 'goto'
  );
  const startsWithNavigate = firstNavigateIndex === 0 ||
    (analysis.createsBeforeUse && firstNavigateIndex === analysis.createIndex + 1);

  if (startsWithNavigate) {
    return { success: true };
  }

  // Check if port is open before navigating (localhost only)
  const portCheck = await checkPortBeforeNavigation(sequence.startUrl, logPrefix);
  if (!portCheck.success) {
    return portCheck;
  }

  await debugLog(logPrefix, `Auto-navigating to startUrl: ${sequence.startUrl}`);
  try {
    await executeToolCall('navigate', {
      action: 'goto',
      url: sequence.startUrl,
      connection
    });
    await debugLog(logPrefix, `Navigated to startUrl: ${sequence.startUrl}`);
    return { success: true };
  } catch (navError: any) {
    return {
      success: false,
      error: `Failed to navigate to startUrl: ${navError.message}`
    };
  }
}

/**
 * Validate that navigation succeeded (page loaded correctly)
 */
export async function validateNavigation(
  ctx: ExecutionContext,
  expectedUrl?: string
): Promise<{ success: boolean; error?: string }> {
  const { executeToolCall, connection, logPrefix = 'executor' } = ctx;

  try {
    const infoResult = await executeToolCall('navigate', {
      action: 'info',
      connection
    });

    // The page's URL and title from `_meta`: the rendered text also carries
    // the page's own title, which may say "ERR_" or "about:blank" in passing.
    const page = infoResult?._meta?.navigate;
    const url: string = page?.url ?? '';
    const title: string = (page?.title ?? '').toLowerCase();

    if (url === 'about:blank' && expectedUrl && expectedUrl !== 'about:blank') {
      return { success: false, error: 'Page failed to load (stuck on about:blank)' };
    }
    if (url.startsWith('chrome-error://')) {
      return { success: false, error: 'Page failed to load: connection error' };
    }
    if (title.includes("site can't be reached")) {
      return { success: false, error: 'Site cannot be reached' };
    }

    debugLog(logPrefix, `Navigation validated successfully`);
    return { success: true };
  } catch (err: any) {
    debugLog(logPrefix, `Navigation validation failed: ${err.message}`);
    return { success: false, error: `Could not validate navigation: ${err.message}` };
  }
}

/**
 * Wait for an element to appear
 */
export async function waitForElement(
  ctx: ExecutionContext,
  selector: string
): Promise<void> {
  const { executeToolCall, connection, logPrefix = 'executor' } = ctx;

  debugLog(logPrefix, `Waiting for element: ${selector}`);

  let retries = 5;
  while (retries > 0) {
    try {
      const result = await executeToolCall('dom', {
        action: 'querySelector',
        selector,
        connection
      });

      if (result && !result.isError) {
        debugLog(logPrefix, `Element ${selector} found`);
        return;
      }
    } catch {
      // Ignore errors during wait
    }

    retries--;
    if (retries > 0) {
      debugLog(logPrefix, `Element ${selector} not found, waiting... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  debugLog(logPrefix, `Warning: Element ${selector} not found after waiting`);
}

/**
 * Validate typed text was entered correctly
 */
export async function validateTypedText(
  ctx: ExecutionContext,
  selector: string,
  expectedText: string,
  append: boolean = false
): Promise<void> {
  const { executeToolCall, connection, logPrefix = 'executor' } = ctx;

  debugLog(logPrefix, `Validating typed text in ${selector}${append ? ' (append mode)' : ''}`);

  try {
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check .value for inputs/textareas, fall back to .innerText for contenteditable elements (e.g., ProseMirror)
    const evalResult = await executeToolCall('inspect', {
      action: 'evaluateExpression',
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return '';
        // For input/textarea, use .value
        if (el.value !== undefined && el.value !== '') return el.value;
        // For contenteditable (ProseMirror, etc.), use innerText
        if (el.isContentEditable || el.contentEditable === 'true') return el.innerText?.trim() || '';
        return el.value || '';
      })()`,
      connection
    });

    const evaluated = evalResult?._meta?.inspect?.value;
    const actualValue = typeof evaluated === 'string' ? evaluated : '';

    // In append mode, check if the field ends with the expected text
    // In replace mode, check for exact match
    if (append) {
      if (!actualValue.endsWith(expectedText)) {
        debugLog(logPrefix, `Text validation failed (append): expected to end with "${expectedText}", got "${actualValue}"`);
        throw new Error(`Text validation failed for ${selector}: expected to end with "${expectedText}", got "${actualValue}"`);
      }
    } else {
      if (actualValue !== expectedText) {
        debugLog(logPrefix, `Text validation failed: expected "${expectedText}", got "${actualValue}"`);
        throw new Error(`Text validation failed for ${selector}: expected "${expectedText}", got "${actualValue}"`);
      }
    }

    debugLog(logPrefix, `Text validated: "${actualValue}" ${append ? 'ends with' : 'matches'} expected`);
  } catch (error: any) {
    if (error.message?.includes('Text validation failed')) {
      throw error;
    }
    debugLog(logPrefix, `Warning: Could not validate typed text: ${error}`);
  }
}

// =============================================================================
// Click Validation
// =============================================================================

export interface PreClickState {
  consoleErrorCount: number;
  consoleWarnCount: number;
  consoleTotalCount: number;
  networkRequestCount: number;
  /** The network read's clock before the click, so a later read takes only what the click caused. */
  networkSince?: number;
  url: string;
  /** ids of the most-recent console errors seen before the click (bounded by
   *  CLICK_VALIDATION_ERROR_SAMPLE), to identify which post-click errors are
   *  actually new rather than just diffing a count. */
  errorIdsBeforeClick: Set<string>;
}

/** How many of the most recent console errors to sample around a click - enough
 *  to identify every genuinely new one in the common case, without pulling the
 *  whole console history for a check that runs after every click. */
const CLICK_VALIDATION_ERROR_SAMPLE = 10;

/** Browser-initiated noise a click didn't cause and can't prevent - a missing
 *  favicon 404s on nearly every page load, unrelated to what was clicked. */
function isNoiseConsoleUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return /\/favicon\.ico$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export interface ClickValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
  /** Present where the click hit another element than the one recorded. */
  repair?: ElementRepair;
}

/**
 * Capture pre-click state for delta comparison
 */
export async function capturePreClickState(ctx: ExecutionContext): Promise<PreClickState> {
  const { executeToolCall, connection, logPrefix = 'executor' } = ctx;

  let consoleErrorCount = 0;
  let consoleWarnCount = 0;
  let consoleTotalCount = 0;
  let networkRequestCount = 0;
  let networkSince: number | undefined;
  let url = '';
  let errorIdsBeforeClick = new Set<string>();

  try {
    // Get console counts via _meta, plus the most recent errors' ids so a
    // post-click diff can tell which ones are actually new.
    const consoleResult = await executeToolCall('console', {
      action: 'recent', type: 'error', count: CLICK_VALIDATION_ERROR_SAMPLE, connection
    });
    consoleErrorCount = consoleResult?._meta?.console?.errorCount || 0;
    consoleWarnCount = consoleResult?._meta?.console?.warnCount || 0;
    consoleTotalCount = consoleResult?._meta?.console?.totalCount || 0;
    errorIdsBeforeClick = new Set((consoleResult?._meta?.console?.entries || []).map((e: { id: string }) => e.id));
  } catch {
    debugLog(logPrefix, 'Warning: Could not get pre-click console state');
  }

  try {
    // Get network request count via _meta
    const networkResult = await executeToolCall('network', {
      action: 'list', limit: 1, connection
    });
    networkRequestCount = networkResult?._meta?.network?.totalCount || 0;
    networkSince = networkResult?._meta?.network?.at;
  } catch {
    debugLog(logPrefix, 'Warning: Could not get pre-click network state');
  }

  try {
    // Get current URL via _meta
    const pageResult = await executeToolCall('navigate', {
      action: 'info', connection
    });
    url = pageResult?._meta?.navigate?.url || '';
  } catch {
    debugLog(logPrefix, 'Warning: Could not get pre-click URL');
  }

  return { consoleErrorCount, consoleWarnCount, consoleTotalCount, networkRequestCount, networkSince, url, errorIdsBeforeClick };
}

/**
 * Validate click action results
 */
export async function validateClickAction(
  ctx: ExecutionContext,
  preState: PreClickState,
  clickResult: any,
  config: ClickValidationConfig,
  /** What this step did when it was recorded, where the sequence kept it. */
  recorded?: StepTraffic,
  /** The element this step acted on when it was recorded. */
  expectedElement?: ElementFingerprint,
): Promise<ClickValidationResult> {
  const { executeToolCall, connection, logPrefix = 'executor' } = ctx;
  const errors: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];

  // Get structured data from _meta
  const clickMeta: ClickActionMeta | undefined = clickResult?._meta?.click;

  // A selector or point that now reaches another element still clicks, and
  // the step reads as passed while the run fails later at a step unrelated to
  // the change. Compared before anything else, so the pause names the cause.
  let repair: ElementRepair | undefined;
  if (expectedElement && clickMeta?.fingerprint) {
    const compared = compareFingerprints(expectedElement, clickMeta.fingerprint);
    if (!compared.same) {
      errors.push(`clicked another element: recorded ${describeFingerprint(expectedElement)}, hit ${describeFingerprint(clickMeta.fingerprint)} (${compared.differ.join(', ')} differ)`);
      const located = connection ? await unlisted(() => locateFingerprint(executeToolCall, connection, expectedElement)) : undefined;
      repair = { matches: located?.count ?? 0, ...(located?.selector ? { selector: located.selector } : {}), hit: clickMeta.fingerprint };
    } else if (compared.advisory.length > 0) {
      info.push(`same element, its ${compared.advisory.join(' and ')} changed: ${describeFingerprint(clickMeta.fingerprint)}`);
    }
  }

  // Small delay before validation
  if (config.postClickDelayMs > 0) {
    await new Promise(r => setTimeout(r, config.postClickDelayMs));
  }

  // 1. Check if click had any effect (DOM changes)
  if (config.requireDomChanges && clickMeta?.domChanges) {
    if (clickMeta.domChanges.mutationCount === 0) {
      const msg = 'Click had no DOM effect (0 mutations)';
      if (config.domChangesFailMode === 'error') {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
  }

  // 2. Check for navigation and validate it
  if (config.validateNavigation && clickMeta?.navigationOccurred) {
    const navResult = await validateNavigation(ctx);
    if (!navResult.success) {
      errors.push(`Navigation failed: ${navResult.error}`);
    }
  }

  // 3. Check for new console messages
  try {
    const consoleResult = await executeToolCall('console', {
      action: 'recent', type: 'error', count: CLICK_VALIDATION_ERROR_SAMPLE, connection
    });
    const newErrorCount = consoleResult?._meta?.console?.errorCount || 0;
    const newWarnCount = consoleResult?._meta?.console?.warnCount || 0;
    const newTotalCount = consoleResult?._meta?.console?.totalCount || 0;

    // Report new errors (respecting failOnConsoleErrors config), excluding ones
    // identifiable as browser noise unrelated to the click (e.g. a favicon 404).
    if (config.failOnConsoleErrors && newErrorCount > preState.consoleErrorCount) {
      const diff = newErrorCount - preState.consoleErrorCount;
      const newEntries: Array<{ id: string; url?: string; text?: string }> = consoleResult?._meta?.console?.entries || [];
      const genuinelyNew = newEntries.filter(e => !preState.errorIdsBeforeClick.has(e.id));
      const actionable = genuinelyNew.filter(e => !isNoiseConsoleUrl(e.url));
      // Chrome logs a request answered 4xx or 5xx as a console error. The
      // recording ran into the same ones when this step failed that many
      // requests, so they are what the step does rather than what broke; a
      // script error, or more failures than were recorded, still stops it.
      const failedRequests = actionable.filter(e => /^Failed to load resource/.test(e.text ?? ''));
      const asRecorded = actionable.length > 0
        && failedRequests.length === actionable.length
        && failedRequests.length <= (recorded?.failed ?? 0);

      if (asRecorded) {
        const lines = (recorded?.lines ?? []).filter(line => / [45]\d\d$/.test(line));
        info.push(`${failedRequests.length} failed request(s) after click, as recorded${lines.length ? ` (${lines.join(', ')})` : ''}`);
      } else if (genuinelyNew.length === 0 || actionable.length > 0) {
        const msg = `${diff} new console error(s) after click`;
        if (config.consoleErrorsFailMode === 'error') {
          errors.push(msg);
        } else {
          warnings.push(msg);
        }
      } else {
        info.push(`${diff} new console error(s) after click, all identified as unrelated browser noise (e.g. favicon) - ignored`);
      }
    }

    // Report new warnings as info
    if (newWarnCount > preState.consoleWarnCount) {
      const diff = newWarnCount - preState.consoleWarnCount;
      info.push(`${diff} new console warning(s)`);
    }

    // Report other new messages (log/info) as info
    const newLogInfoCount = (newTotalCount - newErrorCount - newWarnCount) -
                            (preState.consoleTotalCount - preState.consoleErrorCount - preState.consoleWarnCount);
    if (newLogInfoCount > 0) {
      info.push(`${newLogInfoCount} new console log(s)`);
    }
  } catch {
    debugLog(logPrefix, 'Warning: Could not check console after click');
  }

  // 4. Check for network request failures
  if (config.validateNetworkPayload) {
    try {
      // Requests started since the pre-click read, so a POST that failed
      // earlier in the session is not charged to this click. Without that
      // clock nothing separates the two, and nothing is charged.
      if (preState.networkSince !== undefined) {
        const networkResult = await executeToolCall('network', {
          action: 'list', connection, since: preState.networkSince, limit: 100000,
        });
        const rows: Array<{ method: string; status?: number }> = networkResult?._meta?.network?.requests ?? [];
        const failedPosts = rows.filter(r => r.method === 'POST' && r.status !== undefined && r.status >= 400 && r.status < 500);
        if (failedPosts.length > 0) {
          const msg = `${failedPosts.length} POST request(s) answered 4xx after click`;
          if (config.networkFailMode === 'error') {
            errors.push(msg);
          } else {
            warnings.push(msg);
          }
        }
      }
    } catch {
      debugLog(logPrefix, 'Warning: Could not check network after click');
    }
  }

  // Log validation result
  if (errors.length > 0) {
    debugLog(logPrefix, `Click validation failed: ${errors.join('; ')}`);
  } else if (warnings.length > 0) {
    debugLog(logPrefix, `Click validation warnings: ${warnings.join('; ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info,
    ...(repair ? { repair } : {}),
  };
}

/**
 * Gather diagnostic information after a failure
 */
export async function gatherDiagnostics(ctx: ExecutionContext): Promise<string> {
  const { executeToolCall, connection } = ctx;

  if (!connection) return '';

  try {
    const consoleResult = await executeToolCall('console', {
      action: 'list',
      type: 'error',
      connection
    });
    // Counts from `_meta`: the rendered text carries logged messages and URLs,
    // whose own words and digits would count too.
    const errorCount = consoleResult?._meta?.console?.errorCount ?? 0;

    // `network search` requires a pattern, and reads statusCode as an exact
    // code or an "Nxx" class.
    const countRequests = async (statusCode: string) => {
      const result = await executeToolCall('network', {
        action: 'search',
        pattern: '.',
        statusCode,
        connection
      });
      return result?._meta?.network?.matchCount ?? 0;
    };
    const failedRequests = (await countRequests('4xx')) + (await countRequests('5xx'));

    // Counting interactive elements runs page JS, which a paused page never
    // answers; where it is paused is the state worth reporting instead.
    const pausedAt = await checkIfPaused(ctx);
    if (pausedAt) {
      const where = `${pausedAt.url}:${pausedAt.lineNumber}${pausedAt.functionName ? ` in ${pausedAt.functionName}` : ''}`;
      return ` | Page state: paused at ${where}, ${errorCount} console errors, ${failedRequests} failed requests`;
    }

    const interactiveResult = await executeToolCall('content', {
      action: 'findInteractive',
      connection
    });
    const interactiveCount = interactiveResult?._meta?.content?.totalCount ?? 'unknown';

    return ` | Page state: ${interactiveCount} interactive elements, ${errorCount} console errors, ${failedRequests} failed requests`;
  } catch (err: any) {
    // Logged, so a probe that fails leaves a record of why the page state is missing.
    debugLog(ctx.logPrefix || 'executor', `Could not gather diagnostics: ${err?.message || err}`);
    return '';
  }
}
