/**
 * Calls written against tools the merge removed, rewritten into the calls
 * that replace them: the connection tools and `tab` into `connection` and
 * `browser`, and the single-operation tools into `source`, `modal`,
 * `download` and `config`.
 *
 * Saved sequences, sequences pulled from GitHub, `history.log` and direct
 * callers (the CLI, the bench, internal code) still carry the old names. Each
 * is rewritten where it enters: when a sequence file or pulled sequence is
 * read, when a history line is read, and in `executeToolCall` before the call
 * is validated and recorded, so history holds the new form. `listTools` lists
 * the new names only.
 */

interface Call {
  tool: string;
  params: Record<string, any>;
}

type Rewrite = (params: Record<string, any>) => Call;

/** Drops the listed keys and sets the rest, leaving undefined values out. */
function withParams(base: Record<string, any>, drop: string[], set: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!drop.includes(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(set)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

const REWRITES: Record<string, Rewrite> = {
  launchChrome: p => ({ tool: 'connection', params: withParams(p, ['reference'], { action: 'launch', name: p.reference }) }),
  connectDebugger: p => ({ tool: 'connection', params: withParams(p, ['reference'], { action: 'attach', name: p.reference }) }),
  disconnectDebugger: p => ({ tool: 'connection', params: withParams(p, ['reference'], { action: 'close', connectionReason: p.reference }) }),
  switchConnection: p => ({ tool: 'connection', params: withParams(p, ['reference'], { action: 'switch', connectionReason: p.reference }) }),
  listConnections: p => ({ tool: 'connection', params: withParams(p, [], { action: 'list' }) }),
  getDebuggerStatus: p => ({ tool: 'connection', params: withParams(p, ['reference'], { action: 'status', connectionReason: p.reference }) }),
  getChromeStatus: p => ({ tool: 'connection', params: withParams(p, [], { action: 'browsers' }) }),
  killChrome: p => ({ tool: 'browser', params: withParams(p, [], { action: 'kill' }) }),
  resetChromeLauncher: p => ({ tool: 'browser', params: withParams(p, [], { action: 'resetLauncher' }) }),
  getSourceCode: p => ({ tool: 'source', params: withParams(p, [], { action: 'get' }) }),
  loadSourceMaps: p => ({ tool: 'source', params: withParams(p, [], { action: 'loadMaps' }) }),
  detectModals: p => ({ tool: 'modal', params: withParams(p, [], { action: 'detect' }) }),
  dismissModal: p => ({ tool: 'modal', params: withParams(p, [], { action: 'dismiss' }) }),
  saveToDisk: p => ({ tool: 'download', params: p }),
  setDebugLogging: p => ({ tool: 'config', params: withParams(p, [], { action: 'setDebugLogging' }) }),
  getDebugLoggingStatus: p => ({ tool: 'config', params: withParams(p, [], { action: 'debugLoggingStatus' }) }),
  // `tab` took every key for every action and `connection` is strict, so each
  // action carries only the keys its connection action accepts.
  tab: p => {
    switch (p.action) {
      case 'create':
        return { tool: 'connection', params: withParams({}, [], { action: 'launch', name: p.reference, url: p.url, bringToFront: p.bringToFront }) };
      case 'rename':
        return { tool: 'connection', params: withParams({}, [], { action: 'rename', connectionReason: p.reference, name: p.newReference }) };
      case 'switch':
        return { tool: 'connection', params: withParams({}, [], { action: 'switch', connectionReason: p.reference, bringToFront: p.bringToFront }) };
      case 'close':
        return { tool: 'connection', params: withParams({}, [], { action: 'close', connectionReason: p.reference, reason: p.reason ?? 'closed with tab close' }) };
      default:
        return { tool: 'connection', params: { action: 'list' } };
    }
  },
};

/** What an old tool name became, for the error an MCP call to it returns. */
const REPLACEMENTS: Record<string, string> = {
  launchChrome: "connection with action: 'launch' (reference is now name)",
  connectDebugger: "connection with action: 'attach' (reference is now name)",
  disconnectDebugger: "connection with action: 'close' (reference is now connectionReason)",
  switchConnection: "connection with action: 'switch' (reference is now connectionReason)",
  listConnections: "connection with action: 'list'",
  getDebuggerStatus: "connection with action: 'status' (reference is now connectionReason)",
  getChromeStatus: "connection with action: 'browsers'",
  killChrome: "browser with action: 'kill'",
  resetChromeLauncher: "browser with action: 'resetLauncher'",
  tab: "connection: list, switch, rename and close; a new tab is connection launch with the port of the Chrome to open it in (a translated tab create opens it in the Chrome on the reserved port, or starts one there)",
  getSourceCode: "source with action: 'get'",
  loadSourceMaps: "source with action: 'loadMaps'",
  detectModals: "modal with action: 'detect'",
  dismissModal: "modal with action: 'dismiss'",
  saveToDisk: 'download, with the same parameters',
  setDebugLogging: "config with action: 'setDebugLogging'",
  getDebugLoggingStatus: "config with action: 'debugLoggingStatus'",
};

/** The call an old one became, or the call unchanged when its tool still exists. */
export function translateCall(tool: string, params: Record<string, any> | undefined): Call {
  const rewrite = REWRITES[tool];
  return rewrite ? rewrite(params ?? {}) : { tool, params: params ?? {} };
}

/** What replaced an old tool name, or undefined for a name that was never replaced. */
export function replacementFor(tool: string): string | undefined {
  return REPLACEMENTS[tool];
}

/** A sequence's steps and teardown rewritten step by step; everything else kept. */
export function translateSequence<T extends { commands?: Array<{ tool: string; params?: Record<string, any> }>; teardown?: Array<{ tool: string; params?: Record<string, any> }> }>(sequence: T): T {
  const translateSteps = (steps: Array<{ tool: string; params?: Record<string, any> }>) =>
    steps.map(step => {
      if (!REWRITES[step.tool]) return step;
      const { tool, params } = translateCall(step.tool, step.params);
      return { ...step, tool, params };
    });
  return {
    ...sequence,
    ...(sequence.commands ? { commands: translateSteps(sequence.commands) } : {}),
    ...(sequence.teardown ? { teardown: translateSteps(sequence.teardown) } : {}),
  };
}

/**
 * The tool a direct call reaches: the call translated, then looked up among
 * `tools`. Runs before validation and recording, so a call written against a
 * removed tool runs, and history holds the call it became.
 */
export function callTarget<T>(
  tools: Record<string, T>,
  calledName: string,
  calledParams: Record<string, any> | undefined
): { toolName: string; params: Record<string, any>; tool: T | undefined } {
  const { tool: toolName, params } = translateCall(calledName, calledParams);
  return { toolName, params, tool: Object.prototype.hasOwnProperty.call(tools, toolName) ? tools[toolName] : undefined };
}

/**
 * The MCP answer to a call naming no tool. MCP clients call the names the
 * tool list gives them, so an old name is answered with what replaced it
 * rather than run.
 */
export function unknownToolResponse(toolName: string, availableTools: string[]) {
  const replacedBy = replacementFor(toolName);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          success: false,
          error: `Unknown tool: ${toolName}`,
          code: 'UNKNOWN_TOOL',
          ...(replacedBy ? { replacedBy } : {}),
          availableTools: [...availableTools].sort(),
        }, null, 2),
      },
    ],
    isError: true,
  };
}
