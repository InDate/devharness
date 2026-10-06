/**
 * Source maps for the scripts a debugger connection loads: maps a location in
 * an original source (TypeScript, JSX, anything a map names) to the served
 * script for a breakpoint, maps a paused location back for display, and gives
 * an original file's text from the map that embeds it.
 *
 * Units follow the `source-map` library: lines are 1-based and columns
 * 0-based. Chrome's call frames are 0-based in both, and a breakpoint's line
 * and column are 1-based, so callers convert.
 */

import { SourceMapConsumer } from 'source-map';
import * as fs from 'fs/promises';
import * as path from 'path';
import { debugLog } from './debug-logger.js';

export interface SourcePosition {
  source: string;
  line: number;
  column: number;
}

// A map past these sizes is skipped: parsing one blocks the server's event loop.
const MAX_INLINE_SOURCEMAP_SIZE = 1_000_000; // 1MB base64 ≈ 750KB decoded
const MAX_FILE_SOURCEMAP_SIZE = 10_000_000; // 10MB for file-based source maps

export class SourceMapHandler {
  private sourceMaps: Map<string, SourceMapConsumer> = new Map();
  private pendingSourceMaps: Map<string, string> = new Map(); // scriptUrl → sourceMapURL, loaded when first needed
  /**
   * Maps registered from a build directory, by the generated file's path
   * relative to that directory ("assets/app.js") → the map's path on disk.
   * The page serves the file at a URL whose path ends with the relative path,
   * so that path is both how a script URL finds its map and a URL the
   * breakpoint code resolves to the loaded script. Each is loaded into
   * `sourceMaps` under its relative path when first needed.
   */
  private directoryMaps: Map<string, string> = new Map();
  private loadingPromises: Map<string, Promise<void>> = new Map(); // one load per script at a time
  /**
   * Advanced by clear(). A load that began before a clear finishes after it,
   * so it compares this with the value it started under and drops its map
   * rather than storing it into the cleared handler.
   */
  private generation = 0;

  /** A script's map, by the URL the script names it with; loaded when first needed. */
  registerSourceMap(scriptUrl: string, sourceMapURL: string): void {
    this.pendingSourceMaps.set(scriptUrl, sourceMapURL);
  }

  /**
   * The original text of a source file, taken from whichever source map carries
   * it. Maps embed `sourcesContent`, so this answers for a bundled or remote app
   * where the file is not on disk at all - which is why it lives here rather
   * than in a caller that could only read the filesystem.
   */
  async getOriginalContent(originalSource: string): Promise<string | null> {
    const fromConsumer = (consumer: SourceMapConsumer): string | null => {
      // Same cast the mapping paths use: `sources` is present at runtime but
      // absent from the union type the library exports.
      const sources = (consumer as any).sources as string[] | undefined;
      if (!sources) return null;
      const match = this.findMatchingSource(sources, originalSource);
      if (!match) return null;
      try {
        return consumer.sourceContentFor(match, true);
      } catch {
        return null;
      }
    };

    for (const consumer of this.sourceMaps.values()) {
      const content = fromConsumer(consumer);
      if (content) return content;
    }

    // Nothing loaded carries it. A map not yet loaded whose script's name
    // starts with the file's name less its extension (app.js for app.ts) is
    // where it will be - loading every map to find out would cost more than
    // the answer is worth.
    const stem = path.basename(this.normalizePath(originalSource)).replace(/\.[^.]+$/, '');
    for (const [scriptUrl, sourceMapURL] of [...this.pendingSourceMaps]) {
      if (!path.basename(this.normalizePath(scriptUrl)).startsWith(stem)) continue;
      await this.loadSourceMapFromURL(scriptUrl, sourceMapURL);
      this.pendingSourceMaps.delete(scriptUrl);
      const consumer = this.sourceMaps.get(scriptUrl);
      if (consumer) {
        const content = fromConsumer(consumer);
        if (content) return content;
      }
    }
    for (const relative of this.directoryMaps.keys()) {
      if (!path.basename(relative).startsWith(stem)) continue;
      const consumer = await this.directoryConsumer(relative);
      if (consumer) {
        const content = fromConsumer(consumer);
        if (content) return content;
      }
    }

    return null;
  }

  /**
   * The source in a map's `sources` that names the same file as
   * `originalSource`: the same path, else the same file in the same parent
   * directory, else the same file name.
   */
  private findMatchingSource(sources: string[], originalSource: string): string | undefined {
    const normalizedSearch = this.normalizePath(originalSource);
    const searchBasename = path.basename(normalizedSearch);

    for (const source of sources) {
      if (this.normalizePath(source) === normalizedSearch) {
        return source;
      }
    }

    const searchParts = normalizedSearch.split('/');
    if (searchParts.length >= 2) {
      const searchSuffix = searchParts.slice(-2).join('/');
      for (const source of sources) {
        if (this.normalizePath(source).endsWith(searchSuffix)) {
          return source;
        }
      }
    }

    for (const source of sources) {
      if (path.basename(this.normalizePath(source)) === searchBasename) {
        return source;
      }
    }

    return undefined;
  }

  /** A path for comparison: without a webpack:// or file:// prefix or leading ./, with / separators. */
  private normalizePath(p: string): string {
    let normalized = p.replace(/^webpack:\/\/[^/]*\//, '');
    normalized = normalized.replace(/^file:\/\//, '');
    normalized = normalized.replace(/\\/g, '/');
    while (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
    }
    return normalized;
  }

  /**
   * The directory-registered map for a script, by the relative path its URL's
   * path ends with; the longest such path when several do ("app.js" and
   * "assets/app.js" both end "http://host/assets/app.js").
   */
  private directoryMapFor(scriptUrl: string): string | undefined {
    const scriptPath = this.normalizePath(scriptUrl.split(/[?#]/)[0].replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''));
    let best: string | undefined;
    for (const relative of this.directoryMaps.keys()) {
      if (scriptPath !== relative && !scriptPath.endsWith('/' + relative)) continue;
      if (!best || relative.length > best.length) best = relative;
    }
    return best;
  }

  /**
   * Where an original line and column were generated. A breakpoint asks for
   * column 0, and an indented line's first mapping starts after the
   * indentation, where the default search - at or before the column - finds
   * nothing; the first mapping after the column on the same line answers then.
   */
  private generatedFor(consumer: SourceMapConsumer, source: string, line: number, column: number): { line: number; column: number } | null {
    for (const bias of [SourceMapConsumer.GREATEST_LOWER_BOUND, SourceMapConsumer.LEAST_UPPER_BOUND]) {
      const generated = consumer.generatedPositionFor({ source, line, column, bias });
      if (generated.line !== null && generated.column !== null) return { line: generated.line, column: generated.column };
    }
    return null;
  }

  /** A directory-registered map's consumer, loaded under its relative path on first use. */
  private async directoryConsumer(relative: string): Promise<SourceMapConsumer | undefined> {
    const mapPath = this.directoryMaps.get(relative);
    if (mapPath && !this.sourceMaps.has(relative)) {
      await this.loadSourceMapFromURL(relative, mapPath);
    }
    return this.sourceMaps.get(relative);
  }

  /**
   * The served script and position an original position was generated at:
   * the script's URL for a map the script named, or its path relative to the
   * registered directory for a directory map. Line 1-based, column 0-based,
   * in and out.
   */
  async mapToGenerated(
    originalSource: string,
    originalLine: number,
    originalColumn: number = 0
  ): Promise<{ generatedFile: string; line: number; column: number } | null> {
    const generation = this.generation;

    for (const [generatedFile, consumer] of this.sourceMaps.entries()) {
      const sources = (consumer as any).sources as string[] | undefined;
      if (!sources) continue;

      const matchingSource = this.findMatchingSource(sources, originalSource);
      if (matchingSource) {
        const generated = this.generatedFor(consumer, matchingSource, originalLine, originalColumn);
        if (generated) {
          return { generatedFile, ...generated };
        }
      }
    }

    // Maps not loaded yet, a copy of the keys since loading removes them.
    for (const scriptUrl of Array.from(this.pendingSourceMaps.keys())) {
      if (this.generation !== generation) return null;

      const sourceMapURL = this.pendingSourceMaps.get(scriptUrl);
      if (!sourceMapURL) continue; // loaded by a concurrent call

      await this.loadSourceMapFromURL(scriptUrl, sourceMapURL);
      this.pendingSourceMaps.delete(scriptUrl);

      const consumer = this.sourceMaps.get(scriptUrl);
      const sources = (consumer as any)?.sources as string[] | undefined;
      if (!consumer || !sources) continue;

      const matchingSource = this.findMatchingSource(sources, originalSource);
      if (matchingSource) {
        const generated = this.generatedFor(consumer, matchingSource, originalLine, originalColumn);
        if (generated) {
          return { generatedFile: scriptUrl, ...generated };
        }
      }
    }

    // Directory maps not yet loaded; one loaded already was searched above.
    for (const relative of this.directoryMaps.keys()) {
      if (this.generation !== generation) return null;
      if (this.sourceMaps.has(relative)) continue;
      const consumer = await this.directoryConsumer(relative);
      const sources = (consumer as any)?.sources as string[] | undefined;
      if (!consumer || !sources) continue;
      const matchingSource = this.findMatchingSource(sources, originalSource);
      if (!matchingSource) continue;
      const generated = this.generatedFor(consumer, matchingSource, originalLine, originalColumn);
      if (generated) {
        return { generatedFile: relative, ...generated };
      }
    }

    return null;
  }

  /**
   * The original source and position a served script's position was generated
   * from, for a script with a map the script named or a directory map covering
   * it. Line 1-based, column 0-based, in and out.
   */
  async mapToOriginal(
    generatedFile: string,
    generatedLine: number,
    generatedColumn: number = 0
  ): Promise<SourcePosition | null> {
    const generation = this.generation;
    let consumer = this.sourceMaps.get(generatedFile);

    if (!consumer && this.pendingSourceMaps.has(generatedFile)) {
      const sourceMapURL = this.pendingSourceMaps.get(generatedFile)!;
      await this.loadSourceMapFromURL(generatedFile, sourceMapURL);
      this.pendingSourceMaps.delete(generatedFile);
      consumer = this.sourceMaps.get(generatedFile);
    }

    if (!consumer) {
      const relative = this.directoryMapFor(generatedFile);
      if (relative) consumer = await this.directoryConsumer(relative);
    }

    if (!consumer || this.generation !== generation) {
      return null;
    }

    const original = consumer.originalPositionFor({
      line: generatedLine,
      column: generatedColumn,
    });

    if (original.source && original.line !== null) {
      return {
        source: original.source,
        line: original.line,
        column: original.column || 0,
      };
    }

    return null;
  }

  /**
   * Load a script's map from a data URI, an http(s) URL read as a path under
   * the working directory, a path relative to the script's URL path, or an
   * absolute path on disk. Concurrent calls for one script share one load.
   */
  async loadSourceMapFromURL(scriptUrl: string, sourceMapURL: string): Promise<void> {
    if (this.sourceMaps.has(scriptUrl)) {
      return;
    }

    const existingPromise = this.loadingPromises.get(scriptUrl);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    const loadPromise = this.doLoadSourceMap(scriptUrl, sourceMapURL);
    this.loadingPromises.set(scriptUrl, loadPromise);

    try {
      await loadPromise;
    } finally {
      this.loadingPromises.delete(scriptUrl);
    }
  }

  /** Stores a loaded map, or drops it when clear() ran after its load began. */
  private async store(scriptUrl: string, rawSourceMap: any, generation: number, loadedFrom: string): Promise<void> {
    const consumer = await new SourceMapConsumer(rawSourceMap);
    if (this.generation !== generation) {
      consumer.destroy();
      return;
    }
    this.sourceMaps.set(scriptUrl, consumer);
    debugLog('sourcemap', `Loaded source map for ${scriptUrl} from ${loadedFrom}`);
  }

  private async doLoadSourceMap(scriptUrl: string, sourceMapURL: string): Promise<void> {
    const generation = this.generation;
    try {
      if (sourceMapURL.startsWith('data:')) {
        // A charset parameter may precede ;base64.
        const match = sourceMapURL.match(/^data:application\/json(?:;charset=[^;]+)?;base64,(.+)$/);
        if (match) {
          const base64Data = match[1];
          if (base64Data.length > MAX_INLINE_SOURCEMAP_SIZE) {
            this.recordError(scriptUrl, `Inline source map too large: ${base64Data.length} chars (max ${MAX_INLINE_SOURCEMAP_SIZE})`);
            return;
          }
          const jsonData = Buffer.from(base64Data, 'base64').toString('utf-8');
          const rawSourceMap = this.parseSourceMapJSON(jsonData, scriptUrl);
          if (rawSourceMap) await this.store(scriptUrl, rawSourceMap, generation, 'an inline data URI');
          return;
        }

        const nonBase64Match = sourceMapURL.match(/^data:application\/json(?:;charset=[^;]+)?,(.+)$/);
        if (nonBase64Match) {
          let jsonData: string;
          try {
            jsonData = decodeURIComponent(nonBase64Match[1]);
          } catch {
            this.recordError(scriptUrl, 'Failed to decode non-base64 data URI');
            return;
          }
          if (jsonData.length > MAX_INLINE_SOURCEMAP_SIZE) {
            this.recordError(scriptUrl, `Inline source map too large: ${jsonData.length} chars`);
            return;
          }
          const rawSourceMap = this.parseSourceMapJSON(jsonData, scriptUrl);
          if (rawSourceMap) await this.store(scriptUrl, rawSourceMap, generation, 'an inline data URI');
          return;
        }

        this.recordError(scriptUrl, 'Unrecognized data URI format');
        return;
      }

      let mapPath: string;
      if (path.isAbsolute(sourceMapURL)) {
        // A map registered from a directory, already a path on disk.
        mapPath = sourceMapURL;
      } else if (sourceMapURL.startsWith('http://') || sourceMapURL.startsWith('https://')) {
        // Read as the same path under the working directory, which holds for
        // a dev server serving the project; the map is not fetched.
        mapPath = path.join(process.cwd(), new URL(sourceMapURL).pathname.replace(/^\//, ''));
      } else {
        // Relative to the script's URL path, under the working directory.
        const scriptPath = scriptUrl.replace(/^https?:\/\/[^/]+/, '');
        mapPath = path.join(process.cwd(), path.dirname(scriptPath), sourceMapURL);
      }

      let stats;
      try {
        stats = await fs.stat(mapPath);
      } catch {
        // Most scripts a page loads have no map on disk at the guessed path.
        return;
      }

      if (stats.size > MAX_FILE_SOURCEMAP_SIZE) {
        this.recordError(scriptUrl, `Source map file too large: ${stats.size} bytes (max ${MAX_FILE_SOURCEMAP_SIZE})`);
        return;
      }

      const mapContent = await fs.readFile(mapPath, 'utf-8');
      const rawSourceMap = this.parseSourceMapJSON(mapContent, scriptUrl);
      if (rawSourceMap) await this.store(scriptUrl, rawSourceMap, generation, mapPath);
    } catch (error) {
      this.recordError(scriptUrl, String(error));
    }
  }

  /** The parsed map, or null for invalid JSON or a map without `mappings`. */
  private parseSourceMapJSON(json: string, scriptUrl: string): any | null {
    try {
      const parsed = JSON.parse(json);
      if (!parsed.mappings || typeof parsed.mappings !== 'string') {
        this.recordError(scriptUrl, 'Invalid source map: missing or invalid mappings');
        return null;
      }
      return parsed;
    } catch (error) {
      this.recordError(scriptUrl, `Invalid JSON in source map: ${error}`);
      return null;
    }
  }

  /** A map that could not be loaded, written to the debug log. */
  private recordError(scriptUrl: string, error: string): void {
    debugLog('sourcemap', `Could not load source map for ${scriptUrl}: ${error}`);
  }

  /**
   * Register the .js.map files in a directory and its subdirectories, each
   * under its generated file's path relative to `root` (see directoryMaps).
   * Nothing is loaded until a location in the script is first mapped.
   */
  async registerSourceMapsFromDirectory(directory: string, root: string = directory): Promise<number> {
    const generation = this.generation;
    let registered = 0;
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      if (this.generation !== generation) return 0;

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          registered += await this.registerSourceMapsFromDirectory(fullPath, root);
        } else if (entry.name.endsWith('.js.map')) {
          const relative = path.relative(root, fullPath.slice(0, -'.map'.length)).split(path.sep).join('/');
          this.directoryMaps.set(relative, path.resolve(fullPath));
          registered++;
        }
      }
    } catch (error) {
      debugLog('sourcemap', `Could not scan directory ${directory}: ${error}`);
    }
    return registered;
  }

  /** Forget every map, loaded or not; a load in flight drops what it loads. */
  clear(): void {
    this.generation++;
    for (const consumer of this.sourceMaps.values()) {
      consumer.destroy();
    }
    this.sourceMaps.clear();
    this.pendingSourceMaps.clear();
    this.directoryMaps.clear();
    this.loadingPromises.clear();
  }

  /**
   * Every original source the registered maps carry, with its text: embedded
   * `sourcesContent`, or the file on disk beside a directory map where the map
   * embeds none. Each map is loaded on the way; a source two maps both carry
   * is listed once. `limit` bounds how many maps are loaded, since each blocks
   * the event loop while it parses.
   */
  async originalSources(limit = 200): Promise<Array<{ source: string; content: string }>> {
    for (const [scriptUrl, sourceMapURL] of [...this.pendingSourceMaps].slice(0, limit)) {
      await this.loadSourceMapFromURL(scriptUrl, sourceMapURL);
      this.pendingSourceMaps.delete(scriptUrl);
    }
    const mapDirs = new Map<string, string>();
    for (const [relative, mapPath] of [...this.directoryMaps].slice(0, limit)) {
      await this.directoryConsumer(relative);
      mapDirs.set(relative, path.dirname(mapPath));
    }
    const found = new Map<string, string>();
    for (const [key, consumer] of this.sourceMaps) {
      const sources = ((consumer as any).sources as string[] | undefined) ?? [];
      for (const source of sources) {
        if (found.has(source)) continue;
        let content: string | null = null;
        try { content = consumer.sourceContentFor(source, true); } catch { content = null; }
        const dir = mapDirs.get(key);
        if (content === null && dir) {
          const onDisk = path.resolve(dir, source.replace(/^webpack:\/\/[^/]*\//, '').replace(/^file:\/\//, ''));
          content = await fs.readFile(onDisk, 'utf8').catch(() => null);
        }
        if (content !== null) found.set(source, content);
      }
    }
    return [...found].map(([source, content]) => ({ source, content }));
  }

  /** The scripts whose maps are loaded, by the key each is stored under. */
  getLoadedSourceMaps(): string[] {
    return Array.from(this.sourceMaps.keys());
  }

  /** Whether a map is loaded or registered for a script. */
  hasSourceMap(file: string): boolean {
    return this.sourceMaps.has(file) || this.pendingSourceMaps.has(file) || this.directoryMapFor(file) !== undefined;
  }
}
