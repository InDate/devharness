/**
 * Centralized path configuration for devharness output directories
 *
 * All data defaults to working directory (<cwd>/.devharness/).
 * Use global: true to save to ~/.devharness/ instead.
 * If cwd is invalid (e.g., "/"), falls back to global automatically.
 *
 * The directory was `.cdp-tools` before the rename in 0.9.0 and holds things
 * users would miss: persistent Chrome profiles (logins, IndexedDB), config,
 * recorded sequences, issues. So this migrates rather than switches - see
 * resolveStateDir.
 */

import { join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { existsSync, accessSync, constants, renameSync } from 'fs';
import { z } from 'zod';

const OUTPUT_DIR = '.devharness';
const LEGACY_OUTPUT_DIR = '.cdp-tools';

/** Migration is announced once per process, not once per path lookup. */
let migrationLogged = false;

/**
 * The state directory under `parent`, migrating a legacy `.cdp-tools` into
 * place if that is what exists.
 *
 * Rename, not copy: it is atomic within a filesystem, so there is no window
 * where half the profiles are in one directory and half in the other. If it
 * fails for any reason - cross-device, permissions, a directory held open on
 * Windows - keep using the legacy directory for this session rather than
 * starting a fresh empty one. A user whose saved logins silently vanished
 * would have no way to connect the two events.
 */
export function resolveStateDir(parent: string): string {
  const current = join(parent, OUTPUT_DIR);
  const legacy = join(parent, LEGACY_OUTPUT_DIR);

  if (existsSync(current)) return current;
  if (!existsSync(legacy)) return current;

  try {
    renameSync(legacy, current);
    if (!migrationLogged) {
      console.error(`[devharness] migrated ${legacy} -> ${current}`);
      migrationLogged = true;
    }
    return current;
  } catch (error) {
    if (!migrationLogged) {
      console.error(
        `[devharness] could not migrate ${legacy} to ${current} ` +
        `(${error instanceof Error ? error.message : String(error)}); ` +
        `continuing to use ${legacy}`
      );
      migrationLogged = true;
    }
    return legacy;
  }
}

/** Global state directory, migrated if needed. */
export function getGlobalBase(): string {
  return process.env.DEVHARNESS_DIR
    || process.env.CDP_TOOLS_DIR  // pre-0.9.0 name, still honoured
    || resolveStateDir(homedir());
}

const pathOptionsSchema = z.object({
  global: z.boolean().optional(),
}).strict();

interface PathConfig {
  globalBase: string;
  workingDirBase: string | null; // null if cwd is invalid
  tempBase: string;
}

let pathConfig: PathConfig | null = null;

/**
 * Check if directory is a valid, writable working directory
 */
function isValidWorkingDirectory(dir: string): boolean {
  // Reject root directories (Unix: /, Windows: \, C:\, D:\, etc.)
  if (dir === '/' || dir === '\\') return false;
  if (/^[A-Za-z]:\\?$/.test(dir)) return false; // Windows drive root like C: or C:\

  // Check if directory exists and is writable
  try {
    if (!existsSync(dir)) return false;
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize path configuration at startup.
 * Called automatically on first path request, but can be called explicitly for early initialization.
 */
export function initializePaths(): PathConfig {
  const globalBase = getGlobalBase();
  const cwd = process.cwd();
  const workingDirBase = isValidWorkingDirectory(cwd)
    ? resolveStateDir(cwd)
    : null;
  // Ephemeral, so it gets the new name outright with nothing to migrate.
  const tempBase = join(tmpdir(), 'devharness');

  pathConfig = { globalBase, workingDirBase, tempBase };
  return pathConfig;
}

/**
 * Override the working-directory base at runtime.
 * Needed because MCP clients (e.g. Claude Desktop) spawn one long-lived
 * server process shared across projects — process.cwd() reflects wherever
 * the client happened to launch from, not the project the user is in.
 *
 * @throws if dir does not exist or is not writable
 */
export function setWorkingDirOverride(dir: string): void {
  if (!isValidWorkingDirectory(dir)) {
    throw new Error(`Not a valid, writable directory: ${dir}`);
  }
  if (!pathConfig) initializePaths();
  pathConfig!.workingDirBase = resolveStateDir(dir);
}

/**
 * Get path for devharness data.
 * Defaults to working directory, use global: true for ~/.devharness/
 *
 * @param segments - Path segments to join (e.g., 'logs', 'debug.log')
 * @param options - { global: true } to use ~/.devharness/ instead of cwd
 * @returns Full path like /project/.devharness/logs/debug.log
 */
export function getOutputPath(
  ...args: [...string[]] | [...string[], z.infer<typeof pathOptionsSchema>]
): string {
  if (!pathConfig) initializePaths();

  // Parse arguments - last arg might be options object
  let segments: string[];
  let global = false;

  const lastArg = args[args.length - 1];
  if (lastArg && typeof lastArg === 'object' && !Array.isArray(lastArg)) {
    // Validate options with Zod - throws on invalid/unknown properties
    const options = pathOptionsSchema.parse(lastArg);
    segments = args.slice(0, -1) as string[];
    global = options.global ?? false;
  } else {
    segments = args as string[];
  }

  // Determine base path
  let base: string;
  if (global) {
    base = pathConfig!.globalBase;
  } else {
    base = pathConfig!.workingDirBase ?? pathConfig!.globalBase;
  }

  return join(base, ...segments);
}

/**
 * The project directory holding .devharness - the cwd for subprocesses that
 * resolve their own context from it (`gh` reading the git remote). Falls back
 * to the home dir when there is no working-dir storage, where `gh` then fails
 * with a clear "no repository" rather than acting on the wrong one.
 */
export function getProjectDir(): string {
  return dirname(getOutputPath());
}

/**
 * Get config path with backwards compatibility.
 * Checks cwd first (if valid and config exists there), then global.
 *
 * @returns Path to config.json
 */
export function getConfigPath(): string {
  if (!pathConfig) initializePaths();

  // Check working directory first for backwards compatibility
  if (pathConfig!.workingDirBase) {
    const wdConfig = join(pathConfig!.workingDirBase, 'config.json');
    if (existsSync(wdConfig)) {
      return wdConfig;
    }
  }

  // Fall back to global
  return join(pathConfig!.globalBase, 'config.json');
}

/**
 * Get path for saving new config.
 *
 * @param options - { global: true } to save to ~/.devharness/ (default: working directory)
 * @returns Path to config.json
 */
export function getConfigSavePath(options?: { global?: boolean }): string {
  if (!pathConfig) initializePaths();
  const global = options?.global ?? false;

  if (global) {
    return join(pathConfig!.globalBase, 'config.json');
  }

  const base = pathConfig!.workingDirBase ?? pathConfig!.globalBase;
  return join(base, 'config.json');
}

/**
 * Get path for temporary/ephemeral data.
 * Uses system temp directory.
 *
 * @param segments - Path segments to join (e.g., 'a4-page.css')
 * @returns Full path like /tmp/devharness/a4-page.css
 */
export function getTempPath(...segments: string[]): string {
  if (!pathConfig) initializePaths();
  return join(pathConfig!.tempBase, ...segments);
}

/**
 * Check if working directory storage is available (cwd is valid).
 */
export function hasWorkingDirStorage(): boolean {
  if (!pathConfig) initializePaths();
  return pathConfig!.workingDirBase !== null;
}

// =============================================================================
// Root relocation: dependents bound to the state root, and the transaction
// that moves it while the process keeps running
// =============================================================================

/**
 * A subsystem whose storage derives from the state root and so must react
 * when `relocateRoot` moves it - a watcher left bound to the old root serves
 * stale data forever, since nothing else invalidates it.
 */
export interface RootBoundResource {
  name: string;
  rebind(root: string): void | Promise<void>;
  /**
   * A non-null string blocks relocation and becomes the rejection's message.
   * Not `canRebind(): boolean` - a truthy `true` and a truthy refusal string
   * both pass `if (resource.canRebind())`, so a boolean-returning predicate
   * silently loses its veto. `null` (or omitting `veto`) is the only "no
   * objection" value.
   */
  veto?(): string | null;
}

const rootBoundRegistry = new Map<string, RootBoundResource>();

/**
 * Register (or replace) a root-bound resource. A second registration under a
 * name already held replaces the first - two entries for the same name would
 * leave the earlier one still veto-checked and rebound after the caller
 * that registered it has moved on, with no way to tell which one applies.
 */
export function registerRootBound(resource: RootBoundResource): void {
  rootBoundRegistry.set(resource.name, resource);
}

/** Drop a resource from the registry - it stops receiving future rebind/veto calls. */
export function unregisterRootBound(name: string): void {
  rootBoundRegistry.delete(name);
}

/**
 * Move the state root live, in-process. Every registered resource's `veto()`
 * runs first; a non-null string from any of them stops the transaction
 * before the root or any resource is touched, so a partial relocation never
 * leaves one resource pointed at the new root while another still holds the
 * old one. With no veto, the root updates, then every resource's `rebind`
 * runs in registration order with the new root.
 */
export function relocateRoot(dir: string): Promise<void> {
  // One at a time: two interleaved would set the root under each other's
  // rebind loop, leaving resources split across both roots.
  const mine = relocating.then(() => relocateNow(dir));
  relocating = mine.catch(() => {});
  return mine;
}

let relocating: Promise<void> = Promise.resolve();

async function relocateNow(dir: string): Promise<void> {
  for (const resource of rootBoundRegistry.values()) {
    const reason = resource.veto?.();
    if (reason) {
      throw new Error(`relocateRoot: '${resource.name}' vetoed the relocation: ${reason}`);
    }
  }

  if (!pathConfig) initializePaths();
  const before = pathConfig!.workingDirBase;
  const oldRoot = getOutputPath();
  setWorkingDirOverride(dir);
  const root = getOutputPath();

  const rebound: RootBoundResource[] = [];
  try {
    for (const resource of rootBoundRegistry.values()) {
      await resource.rebind(root);
      rebound.push(resource);
    }
  } catch (error) {
    // A rebind that throws part-way puts the root and every resource already
    // moved back where they were, so none is left on the new root alone.
    pathConfig!.workingDirBase = before;
    for (const resource of rebound.reverse()) {
      try { await resource.rebind(oldRoot); } catch { /* the error that stopped the relocation is the one reported */ }
    }
    throw error;
  }
}

// Deprecated aliases for backwards compatibility
/** @deprecated Use getOutputPath() */
export function getWorkingDirPath(...segments: string[]): string {
  return getOutputPath(...segments);
}

/** @deprecated Use getOutputPath(...segments, { global: true }) */
export function getGlobalPath(...segments: string[]): string {
  return getOutputPath(...segments, { global: true });
}

/** @deprecated Use getOutputPath() */
export const getHomeOutputPath = getGlobalPath;
