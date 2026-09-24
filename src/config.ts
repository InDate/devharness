/**
 * Configuration Manager
 * Manages user-editable configuration in .devharness/config.json
 */

import * as fs from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { getConfigSavePath, getGlobalBase, getOutputPath, relocateRoot } from './helpers/paths.js';
import {
  debugLog,
  enableDebugLogging,
  disableDebugLogging,
  isDebugEnabled,
  enableHistoryLogging,
  disableHistoryLogging,
  isHistoryLogEnabled,
} from './debug-logger.js';
import { atomicWriteFile } from './atomic-write.js';

/**
 * Port monitoring frequency configuration - interval per level in ms
 */
export interface PortMonitoringFreqMs {
  block: number;
  error: number;
  inform: number;
}

/**
 * Port monitoring configuration
 */
export interface PortMonitoringConfig {
  portMonitoringFreqMs: PortMonitoringFreqMs;
}

/**
 * Replay system configuration
 */
export interface ReplayConfig {
  /** Maximum nested conditional depth (default: 10) */
  maxConditionalDepth: number;
  /** Maximum regex pattern length for url:matches conditions (default: 500) */
  maxRegexLength: number;
  /** Show visual cursor during replay (default: true) */
  showCursor: boolean;
  /** Export path for Playwright tests (default: ./tests/e2e) */
  playwrightExportPath: string;
  /** Export path for Puppeteer tests (default: ./tests/puppeteer) */
  puppeteerExportPath: string;
  /** Maximum delay between commands in ms when recording (default: 1000, 0 = no limit) */
  maxDelayMs: number;
  /**
   * Quiet the boundary holds for after a command returns, in ms (default: 0,
   * off).
   *
   * A command's consequences arrive after it returns. Three mechanisms account
   * for them, and this is the last of the three rather than the first.
   *
   * 1. The cursor clears when the command returns (`releaseCommand`), so a
   *    bucket covers its own command and nothing later. This runs always and
   *    is what makes the rest legible.
   * 2. What the page reports accounts for traffic that starts after the
   *    return: a parser-rooted subresource takes the stamp of the document it
   *    was named by, and a timer-rooted request or send owns nothing. Both are
   *    measurements, and neither needs a wait.
   * 3. This wait, which holds the returning command's cursor in place until
   *    the boundary goes quiet, so traffic starting inside the window is
   *    attributed to it by position.
   *
   * Raise this only where the page cannot report. The wrapper reaches pages
   * and worker targets alike, so what is left is narrow: a worker that opens a
   * socket and schedules on its first line, which runs before the wrapper can
   * be installed into it (holding the resume until it is would stall a service
   * worker's registration, which `network-monitor.test.ts` pins against); a
   * page attached to after its load, whose load requests were already sent;
   * and a page that has frozen `WebSocket.prototype` or `fetch`, where the
   * wrapper gives way rather than throwing. Attribution by position is what is
   * left in those cases.
   *
   * It costs up to `stepSettleCapMs` before the next driving command can mark.
   * The wait is paid out of the gap after a command rather than out of its own
   * response, so a session that does anything between driving commands pays
   * nothing; two driving commands back to back pay the remainder. An app whose
   * chatter carries no rule and no timer root never goes quiet, so the cap
   * rather than the quiet ends every wait there.
   */
  stepSettleMs: number;
  /** Longest a step boundary waits for quiet before giving up (default: 2000) */
  stepSettleCapMs: number;
}

/**
 * DOM change detection configuration
 */
export interface ChangeDetectionConfig {
  /** Enable automatic change detection on actions (default: true) */
  enabled: boolean;
  /** Max time to wait for mutations to settle in ms (default: 2000) */
  settleTimeout: number;
  /** Time of no mutations to consider settled in ms (default: 300) */
  quietPeriod: number;
  /** Longer timeout for page navigation in ms (default: 3000) */
  navigationTimeout: number;
}

/**
 * Click validation configuration for replay sequences
 */
export interface ClickValidationConfig {
  /** Enable click validation in replay sequences (default: true) */
  enabled: boolean;
  /** Validate navigation success if click caused URL change (default: true) */
  validateNavigation: boolean;
  /** Require DOM mutations after click (default: false) */
  requireDomChanges: boolean;
  /** Failure mode for DOM changes check: 'error' stops sequence, 'warn' logs and continues (default: 'warn') */
  domChangesFailMode: 'error' | 'warn';
  /** Check for new console errors after click (default: true) */
  failOnConsoleErrors: boolean;
  /** Failure mode for console errors: 'error' stops sequence, 'warn' logs and continues (default: 'error') */
  consoleErrorsFailMode: 'error' | 'warn';
  /** Validate network requests triggered by click (default: false) */
  validateNetworkPayload: boolean;
  /** Failure mode for network failures: 'error' stops sequence, 'warn' logs and continues (default: 'warn') */
  networkFailMode: 'error' | 'warn';
  /** Delay before validation checks in ms (default: 100) */
  postClickDelayMs: number;
}

/**
 * Chrome configuration
 */
export interface ChromeConfig {
  /** Starting port for Chrome debugging - will find next available if in use (default: 9222) */
  startingDebugPort: number;
  /** Inactivity timeout in minutes before closing connections and Chrome (default: 5, set to 0 to disable) */
  inactivityTimeoutMinutes: number;
  /** Polling interval in minutes for inactivity checks (default: 2) */
  inactivityPollingMinutes: number;
  /**
   * Where named persistent Chrome profiles (`launchChrome({ profile })`) live.
   *
   * Empty string (the default) means the global root `~/.devharness/profiles`,
   * so a profile named "work-google" is shared by every project on this
   * machine. Set it in a project-local config (see `config({action:'useLocal'})`)
   * to give that project its own profile store. Relative paths resolve against
   * the process working directory; a leading `~/` is expanded.
   */
  persistentProfileRoot: string;
}

/**
 * Debug configuration
 */
export interface DebugConfig {
  /** Enable debug logging to debug.log on startup (default: false) */
  enabled: boolean;
  /** Enable history log file - records all commands in replay-compatible format (default: false) */
  historyLogEnabled: boolean;
}

/**
 * List of tools that can be toggled via config
 * New tools added here will be auto-discovered and added to enabled list on startup
 */
export const TOGGLEABLE_TOOLS = [
  'connection',  // Core Chrome/debugger connection
  'tab',         // Tab management
  'breakpoint',  // Breakpoints, logpoints
  'execution',   // Pause, resume, step
  'inspection',  // Call stack, variables, evaluate
  'source',      // Source maps, code search
  'console',     // Console monitoring
  'network',     // Network monitoring
  'page',        // Navigation
  'dom',         // DOM queries
  'screenshot',  // Screenshots, PDF
  'input',       // Click, type, hover
  'content',     // Text extraction, interactive elements
  'modal',       // Modal detection/dismissal
  'storage',     // Cookies, localStorage
  'download',    // File downloads
  'request',     // HTTP requests (node or browser) as sequence steps
  'assert',      // Inline assertions as sequence steps (compare {{var:...}} values)
  'wait',        // Wait primitive for sequences (selector/expression polling, sleep)
  'replay',      // Sequence recording/playback
  'server',      // Dev server management
  'issues',      // Issue tracking
  'message',     // Text between two devharness sessions on this machine
  'bench',       // Hold the page, read the boundary, record sequences, collect comments
  'dashboard',   // Web dashboard for monitoring sessions
  // Note: 'config' is NOT toggleable - always enabled
] as const;

export type ToggleableToolName = typeof TOGGLEABLE_TOOLS[number];

/**
 * Tool dependencies - key depends on values
 * If a dependency is disabled, the dependent tool cannot function
 */
export const TOOL_DEPENDENCIES: Record<string, string[]> = {
  tab: ['connection'],
  breakpoint: ['connection'],
  execution: ['connection'],
  inspection: ['connection'],
  source: ['connection'],
  console: ['connection'],
  network: ['connection'],
  page: ['connection'],
  dom: ['connection'],
  bench: ['connection'],
  screenshot: ['connection'],
  input: ['connection'],
  content: ['connection'],
  modal: ['connection'],
  storage: ['connection'],
  replay: ['connection', 'input', 'page'],
  issues: ['replay'],
};

/**
 * Check for dependency conflicts in tools config
 * Returns array of conflict descriptions (grouped by disabled dependency), empty if no conflicts
 */
export function checkToolDependencyConflicts(enabled: string[], disabled: string[]): string[] {
  // Group dependents by their disabled dependency
  const dependentsByDisabled: Record<string, string[]> = {};

  for (const toolName of enabled) {
    const deps = TOOL_DEPENDENCIES[toolName];
    if (!deps) continue;

    for (const dep of deps) {
      if (disabled.includes(dep)) {
        if (!dependentsByDisabled[dep]) {
          dependentsByDisabled[dep] = [];
        }
        dependentsByDisabled[dep].push(toolName);
      }
    }
  }

  // Build conflict messages grouped by disabled dependency
  const conflicts: string[] = [];
  for (const [disabledTool, dependents] of Object.entries(dependentsByDisabled)) {
    const count = dependents.length;
    const toolWord = count === 1 ? 'tool' : 'tools';
    const dependentsList = dependents.join(', ');
    conflicts.push(`'${disabledTool}' is disabled but required for (${count}) ${toolWord}:\n\t${dependentsList}`);
  }

  return conflicts;
}

/**
 * Root configuration structure
 */
export interface ToolsConfig {
  enabled: string[];   // Tools to enable (auto-populated with new tools on startup)
  disabled: string[];  // Tools to disable (takes priority over enabled)
}

/**
 * Session lifetime configuration.
 *
 * Read by the supervisor process, not this ConfigManager - see
 * src/supervisor/idle-config.ts, which parses the same file directly because
 * the supervisor stays out of the server's module graph. Declared here so the
 * shape stays in one place and `config({ action: 'show' })` reports it.
 */
export interface SessionConfig {
  /**
   * Minutes without any traffic from the MCP client before the server is
   * suspended: it releases its connections, Chrome instances and managed dev
   * servers and exits, while the supervisor stays connected and spawns a
   * fresh server on the next request (default: 120, set to 0 to disable).
   */
  idleSuspendMinutes: number;
  /** How often to check the MCP client is still alive, in seconds (default: 60) */
  clientPollSeconds: number;
}

export interface CdpToolsConfig {
  version: number;
  configLocation: 'local' | 'global';  // Where to load config from on startup
  session: SessionConfig;
  chrome: ChromeConfig;
  portMonitoring: PortMonitoringConfig;
  replay: ReplayConfig;
  changeDetection: ChangeDetectionConfig;
  clickValidation: ClickValidationConfig;
  debug: DebugConfig;
  tools: ToolsConfig;
  github: GithubConfig;
}

export interface GithubConfig {
  /** Off switch for publish/sync/import/link/pullSequence, editable by hand
   *  so it does not depend on an agent to reach. */
  enabled: boolean;
  /** owner/name. '' lets gh infer it from the project's git remote. */
  repo: string;
  timeoutMs: number;
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: CdpToolsConfig = {
  version: 1,
  configLocation: 'local',
  session: {
    idleSuspendMinutes: 120,  // Suspend after 2h of client silence (0 = never)
    clientPollSeconds: 60,    // Check the client is still alive every minute
  },
  chrome: {
    startingDebugPort: 9222,
    inactivityTimeoutMinutes: 5,
    inactivityPollingMinutes: 2,
    persistentProfileRoot: '',  // '' = global ~/.devharness/profiles
  },
  portMonitoring: {
    portMonitoringFreqMs: {
      block: 1000,   // Fast detection for blocking
      error: 2000,   // Standard
      inform: 5000,  // Lower overhead for informational
    },
  },
  replay: {
    maxConditionalDepth: 10,  // Maximum nesting depth for conditional commands
    maxRegexLength: 500,      // Maximum regex pattern length for url:matches
    showCursor: true,         // Show visual cursor during replay
    playwrightExportPath: './tests/e2e',      // Export path for Playwright tests
    puppeteerExportPath: './tests/puppeteer', // Export path for Puppeteer tests
    maxDelayMs: 1000,         // Cap recorded delays at 1 second (0 = no limit)
    stepSettleMs: 0,          // Step boundary settle: off (see ReplayConfig)
    stepSettleCapMs: 2000,
  },
  changeDetection: {
    enabled: true,            // Detect DOM changes by default
    settleTimeout: 2000,      // Max wait for mutations to settle
    quietPeriod: 300,         // No mutations for 300ms = settled
    navigationTimeout: 3000,  // Longer timeout for page loads
  },
  clickValidation: {
    enabled: true,                 // Enable click validation in replay
    validateNavigation: true,      // Check navigation success
    requireDomChanges: false,      // Don't require DOM mutations by default
    domChangesFailMode: 'warn',    // Just warn if no DOM changes
    failOnConsoleErrors: true,     // Check for console errors
    consoleErrorsFailMode: 'error',// Fail on console errors
    validateNetworkPayload: false, // Don't validate network by default
    networkFailMode: 'warn',       // Just warn on network failures
    postClickDelayMs: 100,         // Small delay before validation
  },
  debug: {
    enabled: false,               // Debug logging disabled by default
    historyLogEnabled: false,     // History log disabled by default
  },
  tools: {
    enabled: ['issues'],  // All tools enabled by default
    disabled: [],
  },
  github: {
    enabled: true,
    repo: '',  // '' = let gh infer it from the git remote
    timeoutMs: 20000,
  },
};

/**
 * Configuration Manager
 * Loads and saves configuration from .devharness/config.json
 * Also tracks runtime port state
 */
export class ConfigManager {
  private config: CdpToolsConfig = { ...DEFAULT_CONFIG };
  private loaded = false;
  private loadedFromPath: string | null = null;

  // Runtime port state (not persisted to config file)
  private currentPort: number = DEFAULT_CONFIG.chrome.startingDebugPort;

  // Dependency conflict state - blocks all tool access if set
  private dependencyConflicts: string[] = [];

  // Live-reload watcher state
  private configWatchers: fs.FSWatcher[] = [];
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RELOAD_DEBOUNCE_MS = 250;

  constructor() {
    // Sync load config at construction for early access (e.g., tool registration)
    this.loadSync();
  }

  /**
   * Synchronously load config for early access during module initialization
   */
  private loadSync(): void {
    const localConfigPath = getOutputPath('config.json');
    const globalConfigPath = join(getGlobalBase(), 'config.json');

    try {
      if (fs.existsSync(localConfigPath)) {
        const content = fs.readFileSync(localConfigPath, 'utf-8');
        const loaded = JSON.parse(content);
        this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
        this.loadedFromPath = localConfigPath;
        this.loaded = true;
        // Auto-discover new tools
        if (this.discoverTools()) {
          this.saveSync();
        }
      } else {
        // No local config - create one
        // Seed from global if it exists, otherwise use defaults
        if (fs.existsSync(globalConfigPath)) {
          const content = fs.readFileSync(globalConfigPath, 'utf-8');
          const loaded = JSON.parse(content);
          this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
        } else {
          this.config = { ...DEFAULT_CONFIG };
        }
        // Auto-discover new tools (populates enabled list)
        this.discoverTools();
        // Save to local
        this.loadedFromPath = this.getPreferredConfigPath();
        this.saveSync();
        this.loaded = true;
      }
    } catch {
      // Ignore errors, use defaults
      this.config = { ...DEFAULT_CONFIG };
      this.discoverTools();
    }

    // Validate dependencies after config is fully loaded
    this.validateDependencies();
  }

  /**
   * Validate tool dependencies and store any conflicts
   */
  private validateDependencies(): void {
    this.dependencyConflicts = checkToolDependencyConflicts(
      this.config.tools.enabled,
      this.config.tools.disabled
    );
  }

  /**
   * Check if there are dependency conflicts blocking tool access
   */
  hasDependencyConflicts(): boolean {
    return this.dependencyConflicts.length > 0;
  }

  /**
   * Get the list of dependency conflicts
   */
  getDependencyConflicts(): string[] {
    return [...this.dependencyConflicts];
  }

  /**
   * Get preferred path for creating new config
   * Prefers working directory if .cdp-tools folder exists or can be created
   */
  private getPreferredConfigPath(): string {
    try {
      const wdConfigPath = getOutputPath('config.json');
      const wdBase = dirname(wdConfigPath);

      // If .cdp-tools dir exists in working directory, use it
      if (fs.existsSync(wdBase)) {
        return wdConfigPath;
      }

      // Try to create .cdp-tools dir in working directory
      fs.mkdirSync(wdBase, { recursive: true });
      return wdConfigPath;
    } catch {
      // Fall back to global if working directory is not writable
      return getConfigSavePath();
    }
  }

  /**
   * Load configuration from disk
   * Checks local config first for configLocation preference.
   * If configLocation is 'global', uses global config.
   * Otherwise creates/uses local config (seeding from global if available).
   */
  async load(): Promise<void> {
    const localConfigPath = getOutputPath('config.json');
    const globalConfigPath = join(getGlobalBase(), 'config.json');

    try {
      // Check if local config exists and has configLocation preference
      if (fs.existsSync(localConfigPath)) {
        const content = await fs.promises.readFile(localConfigPath, 'utf-8');
        const loaded = JSON.parse(content);

        // If local config says to use global, switch to global
        if (loaded.configLocation === 'global' && fs.existsSync(globalConfigPath)) {
          const globalContent = await fs.promises.readFile(globalConfigPath, 'utf-8');
          const globalLoaded = JSON.parse(globalContent);
          this.config = this.mergeConfig(DEFAULT_CONFIG, globalLoaded);
          this.loadedFromPath = globalConfigPath;
          // Auto-discover new tools
          if (this.discoverTools()) {
            await debugLog('ConfigManager', `Discovered new tools, updating config`);
          }
          await debugLog('ConfigManager', `Using global config (per local configLocation setting)`);

          // Clean up local config to just have the pointer (atomic write)
          await atomicWriteFile(
            localConfigPath,
            JSON.stringify({ configLocation: 'global' }, null, 2)
          );

          await this.save();
          return;
        }

        // Use local config
        this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
        this.loadedFromPath = localConfigPath;
        // Auto-discover new tools
        if (this.discoverTools()) {
          await debugLog('ConfigManager', `Discovered new tools, updating config`);
        }
        await debugLog('ConfigManager', `Loaded config from ${localConfigPath}`);
        await this.save();
      } else {
        // No local config - create one
        // Seed from global if it exists, otherwise use defaults
        if (fs.existsSync(globalConfigPath)) {
          const content = await fs.promises.readFile(globalConfigPath, 'utf-8');
          const loaded = JSON.parse(content);
          this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
          await debugLog('ConfigManager', `Seeding local config from global ${globalConfigPath}`);
        } else {
          this.config = { ...DEFAULT_CONFIG };
        }
        // Auto-discover new tools
        if (this.discoverTools()) {
          await debugLog('ConfigManager', `Discovered new tools, updating config`);
        }
        // Save to local (getPreferredConfigPath will fall back to global if local not writable)
        this.loadedFromPath = this.getPreferredConfigPath();
        await this.save();
        await debugLog('ConfigManager', `Created config at ${this.loadedFromPath}`);
      }
    } catch (err) {
      await debugLog('ConfigManager', `Failed to load config: ${err}, using defaults`);
      this.config = { ...DEFAULT_CONFIG };
      this.loadedFromPath = null;
    }

    // Validate dependencies after config is fully loaded
    this.validateDependencies();
    if (this.hasDependencyConflicts()) {
      await debugLog('ConfigManager', `Tool dependency conflicts detected: ${this.dependencyConflicts.join(', ')}`);
    }

    this.loaded = true;
  }

  /**
   * Re-read config.json from disk and apply it to the running process.
   * Unlike load(), this never writes back (no discover-and-persist) - it's
   * meant to pick up a manual edit live, not to run the one-time bootstrap,
   * and writing back here would re-trigger the file watcher that calls it.
   */
  async reload(): Promise<{ changed: boolean; path: string | null }> {
    const localConfigPath = getOutputPath('config.json');
    const globalConfigPath = join(getGlobalBase(), 'config.json');

    const previousSnapshot = JSON.stringify(this.config);
    const previousDebug = { ...this.config.debug };

    let nextConfig: CdpToolsConfig;
    let nextPath: string;

    try {
      if (fs.existsSync(localConfigPath)) {
        const content = await fs.promises.readFile(localConfigPath, 'utf-8');
        const loaded = JSON.parse(content);

        if (loaded.configLocation === 'global' && fs.existsSync(globalConfigPath)) {
          const globalContent = await fs.promises.readFile(globalConfigPath, 'utf-8');
          nextConfig = this.mergeConfig(DEFAULT_CONFIG, JSON.parse(globalContent));
          nextPath = globalConfigPath;
        } else {
          nextConfig = this.mergeConfig(DEFAULT_CONFIG, loaded);
          nextPath = localConfigPath;
        }
      } else if (fs.existsSync(globalConfigPath)) {
        const content = await fs.promises.readFile(globalConfigPath, 'utf-8');
        nextConfig = this.mergeConfig(DEFAULT_CONFIG, JSON.parse(content));
        nextPath = globalConfigPath;
      } else {
        // Nothing on disk (e.g. deleted) - keep the current in-memory config.
        return { changed: false, path: this.loadedFromPath };
      }
    } catch (err) {
      await debugLog('ConfigManager', `Config reload failed: ${err}`);
      return { changed: false, path: this.loadedFromPath };
    }

    this.config = nextConfig;
    this.loadedFromPath = nextPath;
    this.validateDependencies();

    const changed = JSON.stringify(this.config) !== previousSnapshot;
    if (changed) {
      await debugLog('ConfigManager', `Config reloaded from ${nextPath}`);
      this.applyLiveDebugSettings(previousDebug);
    }

    return { changed, path: nextPath };
  }

  /**
   * debug.enabled/historyLogEnabled are otherwise only applied once at
   * server startup (see main() in index.ts) - mirror that here so a live
   * edit actually flips debug-logger.ts's module state.
   */
  private applyLiveDebugSettings(previousDebug: DebugConfig): void {
    const next = this.config.debug;

    if (next.enabled !== previousDebug.enabled) {
      if (next.enabled && !isDebugEnabled()) {
        void enableDebugLogging();
      } else if (!next.enabled && isDebugEnabled()) {
        disableDebugLogging();
      }
    }

    if (next.historyLogEnabled !== previousDebug.historyLogEnabled) {
      if (next.historyLogEnabled && !isHistoryLogEnabled()) {
        enableHistoryLogging();
      } else if (!next.historyLogEnabled && isHistoryLogEnabled()) {
        disableHistoryLogging();
      }
    }
  }

  /**
   * Watch the local and global config directories for edits and hot-reload
   * config.json into the running process. Watches the parent directory
   * (not the file itself) and ignores the event payload, debouncing to a
   * full reload() - same pattern as issue-tracker.ts's watcher, and safe
   * against atomic saves (write-temp + rename) losing the watch descriptor.
   *
   * Note: tools.enabled/tools.disabled cannot be hot-applied this way - the
   * MCP tool list is built once at server startup. Everything else this
   * class exposes (portMonitoring, replay, changeDetection, clickValidation,
   * debug) is read live from getConfig() and picks up a reload immediately.
   */
  startWatching(): void {
    if (this.configWatchers.length > 0) return;

    const dirsToWatch = new Set<string>([
      dirname(getOutputPath('config.json')),
      dirname(join(getGlobalBase(), 'config.json')),
    ]);

    for (const dir of dirsToWatch) {
      try {
        const watcher = fs.watch(dir, () => this.scheduleReload());
        this.configWatchers.push(watcher);
      } catch {
        // Directory doesn't exist yet / not watchable on this platform - skip silently.
      }
    }
  }

  stopWatching(): void {
    for (const watcher of this.configWatchers) {
      watcher.close();
    }
    this.configWatchers = [];
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }

  /**
   * Coalesce a burst of filesystem events into one reload, firing a fixed
   * window after the FIRST event rather than the last.
   *
   * This used to clear and re-arm the timer on every event, which is the
   * textbook debounce - and the wrong shape here. startWatching() watches the
   * global ~/.devharness directory as well as the project one, and that
   * directory is shared by every devharness process on the machine (dashboard
   * locks, downloads, sequences). Under sustained unrelated writes there, the
   * timer was reset before it could ever fire, so an edit to config.json was
   * postponed indefinitely - live reload silently stopped working, and stayed
   * broken for as long as the other process kept writing.
   *
   * Firing from the first event bounds the latency at RELOAD_DEBOUNCE_MS no
   * matter how busy the directory is, while still collapsing the rapid
   * write/rename pairs an atomic save produces.
   */
  private scheduleReload(): void {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.reload();
    }, ConfigManager.RELOAD_DEBOUNCE_MS);
  }

  /**
   * Deep merge two config objects
   */
  private mergeConfig(defaults: CdpToolsConfig, loaded: Partial<CdpToolsConfig>): CdpToolsConfig {
    return {
      version: loaded.version ?? defaults.version,
      configLocation: loaded.configLocation ?? defaults.configLocation,
      session: {
        idleSuspendMinutes: loaded.session?.idleSuspendMinutes ?? defaults.session.idleSuspendMinutes,
        clientPollSeconds: loaded.session?.clientPollSeconds ?? defaults.session.clientPollSeconds,
      },
      chrome: {
        startingDebugPort: loaded.chrome?.startingDebugPort ?? defaults.chrome.startingDebugPort,
        inactivityTimeoutMinutes: loaded.chrome?.inactivityTimeoutMinutes ?? defaults.chrome.inactivityTimeoutMinutes,
        inactivityPollingMinutes: loaded.chrome?.inactivityPollingMinutes ?? defaults.chrome.inactivityPollingMinutes,
        persistentProfileRoot: loaded.chrome?.persistentProfileRoot ?? defaults.chrome.persistentProfileRoot,
      },
      portMonitoring: {
        portMonitoringFreqMs: {
          block: loaded.portMonitoring?.portMonitoringFreqMs?.block ?? defaults.portMonitoring.portMonitoringFreqMs.block,
          error: loaded.portMonitoring?.portMonitoringFreqMs?.error ?? defaults.portMonitoring.portMonitoringFreqMs.error,
          inform: loaded.portMonitoring?.portMonitoringFreqMs?.inform ?? defaults.portMonitoring.portMonitoringFreqMs.inform,
        },
      },
      replay: {
        maxConditionalDepth: loaded.replay?.maxConditionalDepth ?? defaults.replay.maxConditionalDepth,
        maxRegexLength: loaded.replay?.maxRegexLength ?? defaults.replay.maxRegexLength,
        showCursor: loaded.replay?.showCursor ?? defaults.replay.showCursor,
        playwrightExportPath: loaded.replay?.playwrightExportPath ?? defaults.replay.playwrightExportPath,
        puppeteerExportPath: loaded.replay?.puppeteerExportPath ?? defaults.replay.puppeteerExportPath,
        maxDelayMs: loaded.replay?.maxDelayMs ?? defaults.replay.maxDelayMs,
        stepSettleMs: loaded.replay?.stepSettleMs ?? defaults.replay.stepSettleMs,
        stepSettleCapMs: loaded.replay?.stepSettleCapMs ?? defaults.replay.stepSettleCapMs,
      },
      changeDetection: {
        enabled: loaded.changeDetection?.enabled ?? defaults.changeDetection.enabled,
        settleTimeout: loaded.changeDetection?.settleTimeout ?? defaults.changeDetection.settleTimeout,
        quietPeriod: loaded.changeDetection?.quietPeriod ?? defaults.changeDetection.quietPeriod,
        navigationTimeout: loaded.changeDetection?.navigationTimeout ?? defaults.changeDetection.navigationTimeout,
      },
      clickValidation: {
        enabled: loaded.clickValidation?.enabled ?? defaults.clickValidation.enabled,
        validateNavigation: loaded.clickValidation?.validateNavigation ?? defaults.clickValidation.validateNavigation,
        requireDomChanges: loaded.clickValidation?.requireDomChanges ?? defaults.clickValidation.requireDomChanges,
        domChangesFailMode: loaded.clickValidation?.domChangesFailMode ?? defaults.clickValidation.domChangesFailMode,
        failOnConsoleErrors: loaded.clickValidation?.failOnConsoleErrors ?? defaults.clickValidation.failOnConsoleErrors,
        consoleErrorsFailMode: loaded.clickValidation?.consoleErrorsFailMode ?? defaults.clickValidation.consoleErrorsFailMode,
        validateNetworkPayload: loaded.clickValidation?.validateNetworkPayload ?? defaults.clickValidation.validateNetworkPayload,
        networkFailMode: loaded.clickValidation?.networkFailMode ?? defaults.clickValidation.networkFailMode,
        postClickDelayMs: loaded.clickValidation?.postClickDelayMs ?? defaults.clickValidation.postClickDelayMs,
      },
      debug: {
        enabled: loaded.debug?.enabled ?? defaults.debug.enabled,
        historyLogEnabled: loaded.debug?.historyLogEnabled ?? defaults.debug.historyLogEnabled,
      },
      tools: {
        enabled: loaded.tools?.enabled ?? defaults.tools.enabled,
        disabled: loaded.tools?.disabled ?? defaults.tools.disabled,
      },
      github: {
        enabled: loaded.github?.enabled ?? defaults.github.enabled,
        repo: loaded.github?.repo ?? defaults.github.repo,
        timeoutMs: loaded.github?.timeoutMs ?? defaults.github.timeoutMs,
      },
    };
  }

  /**
   * Save configuration to disk
   * Saves to the same location it was loaded from, or global if new
   */
  async save(): Promise<void> {
    const configPath = this.loadedFromPath || getConfigSavePath();
    // Atomic write handles directory creation and prevents corruption
    await atomicWriteFile(
      configPath,
      JSON.stringify(this.config, null, 2)
    );
  }

  /**
   * Synchronously save configuration to disk
   * Used during loadSync() to persist config before async code runs
   */
  private saveSync(): void {
    const configPath = this.loadedFromPath || getConfigSavePath();
    const dir = dirname(configPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(
      configPath,
      JSON.stringify(this.config, null, 2),
      'utf-8'
    );
  }

  /**
   * Get the full configuration
   */
  getConfig(): CdpToolsConfig {
    if (!this.loaded) {
      // Synchronous fallback - return defaults
      return { ...DEFAULT_CONFIG };
    }
    return this.config;
  }

  /**
   * Get port monitoring configuration
   */
  getPortMonitoringConfig(): PortMonitoringConfig {
    return this.getConfig().portMonitoring;
  }

  /**
   * Get the interval for a specific monitoring level
   */
  getIntervalForLevel(level: 'block' | 'error' | 'inform'): number {
    return this.getPortMonitoringConfig().portMonitoringFreqMs[level];
  }

  /**
   * Get Chrome configuration
   */
  getChromeConfig(): ChromeConfig {
    return this.getConfig().chrome;
  }

  /**
   * Absolute directory that named persistent Chrome profiles live in
   * (`launchChrome({ profile })`, `config({action:'resetProfile'})`).
   *
   * Defaults to the global `~/.devharness/profiles` so a named profile is shared
   * across projects. `chrome.persistentProfileRoot` in a project-local config
   * overrides it; relative values resolve against the working directory and a
   * leading `~/` is expanded.
   */
  getPersistentProfileRoot(): string {
    const configured = (this.getChromeConfig().persistentProfileRoot || '').trim();
    if (!configured) {
      return join(getGlobalBase(), 'profiles');
    }
    if (configured === '~') {
      return homedir();
    }
    if (configured.startsWith('~/')) {
      return join(homedir(), configured.slice(2));
    }
    return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
  }

  /**
   * Get replay system configuration
   */
  getReplayConfig(): ReplayConfig {
    return this.getConfig().replay;
  }

  /**
   * Get change detection configuration
   */
  getChangeDetectionConfig(): ChangeDetectionConfig {
    return this.getConfig().changeDetection;
  }

  /**
   * Get click validation configuration for replay sequences
   */
  getClickValidationConfig(): ClickValidationConfig {
    return this.getConfig().clickValidation;
  }

  /**
   * Get debug configuration
   */
  getDebugConfig(): DebugConfig {
    return this.getConfig().debug;
  }

  /**
   * Get tools configuration
   */
  getToolsConfig(): ToolsConfig {
    return this.getConfig().tools;
  }

  /**
   * Check if a tool is enabled
   * A tool is enabled if it's in the enabled list and not in the disabled list
   */
  isToolEnabled(toolName: string): boolean {
    const tools = this.getToolsConfig();
    // If in disabled list, it's disabled
    if (tools.disabled.includes(toolName)) return false;
    // If in enabled list, it's enabled
    if (tools.enabled.includes(toolName)) return true;
    // Default to disabled if not in either list
    return false;
  }

  /**
   * Auto-discover and enable new tools
   * Any tool in TOGGLEABLE_TOOLS that isn't in disabled will be added to enabled
   * Also removes tools from enabled if they are in disabled
   * Returns true if config was modified
   */
  discoverTools(): boolean {
    let modified = false;

    // Remove any tools from enabled that are in disabled
    for (const toolName of this.config.tools.disabled) {
      const enabledIndex = this.config.tools.enabled.indexOf(toolName);
      if (enabledIndex !== -1) {
        this.config.tools.enabled.splice(enabledIndex, 1);
        modified = true;
      }
    }

    // Auto-add new tools to enabled (if not in disabled)
    for (const toolName of TOGGLEABLE_TOOLS) {
      // Skip if already in enabled or disabled
      if (this.config.tools.enabled.includes(toolName)) continue;
      if (this.config.tools.disabled.includes(toolName)) continue;

      // Auto-add to enabled
      this.config.tools.enabled.push(toolName);
      modified = true;
    }
    return modified;
  }

  /**
   * Get list of available toggleable tools with their current state
   */
  getToggleableTools(): Array<{ name: string; enabled: boolean; dependencies: string[] }> {
    return TOGGLEABLE_TOOLS.map(name => ({
      name,
      enabled: this.isToolEnabled(name),
      dependencies: TOOL_DEPENDENCIES[name] || [],
    }));
  }

  /**
   * Update port monitoring frequency configuration
   */
  async updatePortMonitoringFreqMs(updates: Partial<PortMonitoringFreqMs>): Promise<void> {
    this.config.portMonitoring.portMonitoringFreqMs = {
      ...this.config.portMonitoring.portMonitoringFreqMs,
      ...updates,
    };
    await this.save();
  }

  // Runtime port state methods (not persisted)

  /**
   * Get the current port in use (runtime state)
   */
  getCurrentPort(): number {
    return this.currentPort;
  }

  /**
   * Set the current port (runtime state)
   */
  setCurrentPort(port: number): void {
    this.currentPort = port;
  }

  // Config management methods

  /**
   * Get info about current config location and status
   */
  getStatus(): {
    loadedFrom: string | null;
    isLocal: boolean;
    localPath: string;
    globalPath: string;
    localExists: boolean;
    globalExists: boolean;
  } {
    const localPath = getOutputPath('config.json');
    const globalPath = join(getGlobalBase(), 'config.json');
    return {
      loadedFrom: this.loadedFromPath,
      isLocal: this.loadedFromPath === localPath,
      localPath,
      globalPath,
      localExists: fs.existsSync(localPath),
      globalExists: fs.existsSync(globalPath),
    };
  }

  /**
   * Switch to using local config (creates if needed, optionally seeds from global)
   *
   * @param seedFromGlobal - seed new local config from global if it exists
   * @param projectPath - explicit project directory to treat as "local".
   *   Needed when the MCP server's process.cwd() doesn't reflect the
   *   project the user is currently working in (e.g. a shared long-lived
   *   server process spawned from the home directory).
   */
  async useLocal(seedFromGlobal: boolean = true, projectPath?: string): Promise<{ path: string; seeded: boolean }> {
    if (projectPath) {
      // relocateRoot (not setWorkingDirOverride) so a server holding open log
      // file descriptors against the old root - or any other registered
      // resource - can veto instead of relocating out from under it.
      await relocateRoot(projectPath);
    }

    const localPath = getOutputPath('config.json');
    const globalPath = join(getGlobalBase(), 'config.json');
    const localDir = dirname(localPath);

    // Create directory if needed
    if (!fs.existsSync(localDir)) {
      await fs.promises.mkdir(localDir, { recursive: true });
    }

    let seeded = false;
    if (!fs.existsSync(localPath) && seedFromGlobal && fs.existsSync(globalPath)) {
      // Seed from global
      const content = await fs.promises.readFile(globalPath, 'utf-8');
      const loaded = JSON.parse(content);
      this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
      seeded = true;
    }

    // Set configLocation to local explicitly
    this.config.configLocation = 'local';
    this.loadedFromPath = localPath;
    await this.save();
    return { path: localPath, seeded };
  }

  /**
   * Switch to using global config
   * Writes a minimal local config with just configLocation: 'global'
   */
  async useGlobal(): Promise<{ path: string }> {
    const localPath = getOutputPath('config.json');
    const globalPath = join(getGlobalBase(), 'config.json');
    const localDir = dirname(localPath);
    const globalDir = dirname(globalPath);

    // Ensure global directory exists (for reading config below)
    if (!fs.existsSync(globalDir)) {
      await fs.promises.mkdir(globalDir, { recursive: true });
    }

    // Write minimal local config with just the preference (atomic write)
    const minimalConfig = { configLocation: 'global' as const };
    await atomicWriteFile(
      localPath,
      JSON.stringify(minimalConfig, null, 2)
    );

    // Load and use global config
    if (fs.existsSync(globalPath)) {
      const content = await fs.promises.readFile(globalPath, 'utf-8');
      const loaded = JSON.parse(content);
      this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);
    } else {
      this.config = { ...DEFAULT_CONFIG };
    }

    this.loadedFromPath = globalPath;
    await this.save();
    return { path: globalPath };
  }

  /**
   * Reset config to defaults
   */
  async reset(): Promise<void> {
    this.config = { ...DEFAULT_CONFIG };
    await this.save();
  }

  /**
   * Create a backup of current config
   */
  async backup(): Promise<{ path: string } | null> {
    if (!this.loadedFromPath || !fs.existsSync(this.loadedFromPath)) {
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = this.loadedFromPath.replace('.json', `.backup-${timestamp}.json`);
    await fs.promises.copyFile(this.loadedFromPath, backupPath);
    return { path: backupPath };
  }

  /**
   * Clone global config to local
   */
  async cloneFromGlobal(): Promise<{ path: string } | { error: string }> {
    const globalPath = join(getGlobalBase(), 'config.json');

    if (!fs.existsSync(globalPath)) {
      return { error: 'No global config exists to clone from' };
    }

    const content = await fs.promises.readFile(globalPath, 'utf-8');
    const loaded = JSON.parse(content);
    this.config = this.mergeConfig(DEFAULT_CONFIG, loaded);

    const localPath = getOutputPath('config.json');
    const localDir = dirname(localPath);

    if (!fs.existsSync(localDir)) {
      await fs.promises.mkdir(localDir, { recursive: true });
    }

    this.loadedFromPath = localPath;
    await this.save();
    return { path: localPath };
  }
}

// Export singleton instance
export const configManager = new ConfigManager();
