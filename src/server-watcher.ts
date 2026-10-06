/**
 * Recursive file-change watcher for devharness-managed dev servers.
 *
 * Manual recursive fs.watch (one watcher per directory) rather than the
 * `recursive: true` option, which isn't reliably cross-platform - and
 * rather than a dependency like chokidar, to keep this dependency-free like
 * the rest of this codebase's process-management code. Debounced so a burst
 * of writes (e.g. a save-all, or a build tool writing many files) collapses
 * to one change notification.
 *
 * Known v1 limitation: this opens one file descriptor per watched
 * directory, which doesn't scale to huge trees. Not solved here (no cap,
 * no .gitignore-awareness) - acceptable for typical project sizes, and
 * consistent with the "no new dependency" constraint.
 */
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_EXCLUDE_DIR_NAMES = [
  'node_modules', '.git', 'dist', 'build', '.devharness', '.cdp-tools',
  '.next', 'coverage', 'out', '.turbo', 'tmp',
];

export interface ServerFileWatcherOptions {
  paths: string[];
  excludeDirNames?: string[];
  debounceMs?: number;
  /**
   * How often the watched files' modification times are compared with the
   * last comparison (default 2000; 0 turns it off). fs.watch does not
   * guarantee delivery, and an event it drops is a change no restart follows.
   */
  pollMs?: number;
  onChange: () => void;
}

export class ServerFileWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly excludeDirNames: Set<string>;
  private readonly debounceMs: number;
  private readonly onChange: () => void;
  private stopped = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  /** Each watched file's modification time at the last poll. */
  private seen = new Map<string, number>();
  /** Whether fs.watch delivered an event since the last poll, which leaves that poll nothing to add. */
  private delivered = false;

  constructor(private readonly options: ServerFileWatcherOptions) {
    this.excludeDirNames = new Set(options.excludeDirNames ?? DEFAULT_EXCLUDE_DIR_NAMES);
    this.debounceMs = options.debounceMs ?? 400;
    this.onChange = options.onChange;
  }

  start(): void {
    for (const root of this.options.paths) {
      this.watchDir(root);
    }
    const pollMs = this.options.pollMs ?? 2000;
    if (pollMs > 0) {
      this.seen = this.snapshot();
      this.poll = setInterval(() => this.compare(), pollMs);
      this.poll.unref?.();
    }
  }

  /** Every file in the watched directories with its modification time. */
  private snapshot(): Map<string, number> {
    const files = new Map<string, number>();
    for (const dir of this.watchers.keys()) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const full = path.join(dir, entry.name);
        try { files.set(full, fs.statSync(full).mtimeMs); } catch { /* removed between the read and the stat */ }
      }
    }
    return files;
  }

  private compare(): void {
    if (this.stopped) return;
    const now = this.snapshot();
    const changed = now.size !== this.seen.size
      || [...now].some(([file, mtime]) => this.seen.get(file) !== mtime);
    this.seen = now;
    const missed = changed && !this.delivered;
    this.delivered = false;
    if (missed) this.handleEvent('', null);
  }

  private watchDir(dir: string): void {
    if (this.stopped || this.watchers.has(dir)) {
      return;
    }

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, (_eventType, filename) => this.handleEvent(dir, filename));
    } catch {
      return; // Directory may not exist or isn't readable - skip silently.
    }
    this.watchers.set(dir, watcher);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !this.excludeDirNames.has(entry.name)) {
        this.watchDir(path.join(dir, entry.name));
      }
    }
  }

  private handleEvent(dir: string, filename: string | null): void {
    if (this.stopped) {
      return;
    }
    if (dir) this.delivered = true;

    // A new subdirectory may have just appeared - start watching it too, so
    // future changes inside it aren't missed.
    if (filename) {
      const fullPath = path.join(dir, filename);
      if (!this.watchers.has(fullPath) && !this.excludeDirNames.has(filename)) {
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            this.watchDir(fullPath);
          }
        } catch {
          // Deleted, a file, or a benign race - nothing to do either way.
        }
      }
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.onChange();
    }, this.debounceMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}
