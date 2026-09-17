/**
 * Source Map Handler
 * Handles TypeScript to JavaScript mapping for breakpoints
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

export interface MappedPosition {
  generatedLine: number;
  generatedColumn: number;
  originalLine: number;
  originalColumn: number;
  source: string;
}

// Max size limits to prevent performance issues
const MAX_INLINE_SOURCEMAP_SIZE = 1_000_000; // 1MB base64 ≈ 750KB decoded
const MAX_FILE_SOURCEMAP_SIZE = 10_000_000; // 10MB for file-based source maps

// Track last error for visibility
interface LoadError {
  scriptUrl: string;
  error: string;
  timestamp: number;
}

export class SourceMapHandler {
  private sourceMaps: Map<string, SourceMapConsumer> = new Map();
  private pendingSourceMaps: Map<string, string> = new Map(); // scriptUrl → sourceMapURL (lazy loading)
  private loadingPromises: Map<string, Promise<void>> = new Map(); // prevent concurrent loads with proper deduplication
  private lastErrors: LoadError[] = []; // track recent errors for debugging
  private clearing = false; // flag to prevent operations during clear

  /**
   * Register a source map URL for lazy loading (does not load immediately)
   */
  registerSourceMap(scriptUrl: string, sourceMapURL: string): void {
    if (this.clearing) return;
    this.pendingSourceMaps.set(scriptUrl, sourceMapURL);
  }

  /**
   * The original text of a source file, taken from whichever source map carries
   * it. Maps embed `sourcesContent`, so this answers for a bundled or remote app
   * where the file is not on disk at all - which is why it lives here rather
   * than in a caller that could only read the filesystem.
   */
  async getOriginalContent(originalSource: string): Promise<string | null> {
    if (this.clearing) return null;

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

    // Nothing loaded carries it. A pending map whose script shares the file's
    // name is where it will be - loading every pending map to find out would
    // cost more than the answer is worth.
    const basename = path.basename(this.normalizePath(originalSource));
    for (const [scriptUrl, sourceMapURL] of [...this.pendingSourceMaps]) {
      if (!this.normalizePath(scriptUrl).endsWith(basename)) continue;
      await this.loadSourceMapFromURL(scriptUrl, sourceMapURL);
      this.pendingSourceMaps.delete(scriptUrl);
      const consumer = this.sourceMaps.get(scriptUrl);
      if (consumer) {
        const content = fromConsumer(consumer);
        if (content) return content;
      }
    }

    return null;
  }

  /**
   * Load a source map from a file (with size limit)
   */
  async loadSourceMap(generatedFilePath: string): Promise<void> {
    if (this.clearing) return;

    try {
      const mapPath = `${generatedFilePath}.map`;

      // Check file size before reading
      const stats = await fs.stat(mapPath);
      if (stats.size > MAX_FILE_SOURCEMAP_SIZE) {
        this.recordError(generatedFilePath, `Source map too large: ${stats.size} bytes (max ${MAX_FILE_SOURCEMAP_SIZE})`);
        return;
      }

      const mapContent = await fs.readFile(mapPath, 'utf-8');
      const rawSourceMap = JSON.parse(mapContent);

      const consumer = await new SourceMapConsumer(rawSourceMap);
      if (!this.clearing) {
        this.sourceMaps.set(generatedFilePath, consumer);
      } else {
        consumer.destroy();
      }
    } catch (error) {
      this.recordError(generatedFilePath, String(error));
      // Fire-and-forget debug log
      debugLog('sourcemap', `Could not load source map for ${generatedFilePath}: ${error}`);
    }
  }

  /**
   * Find a matching source in a source map using proper path comparison
   */
  private findMatchingSource(sources: string[], originalSource: string): string | undefined {
    // Normalize the search path
    const normalizedSearch = this.normalizePath(originalSource);
    const searchBasename = path.basename(normalizedSearch);

    // First, try exact match
    for (const source of sources) {
      const normalizedSource = this.normalizePath(source);
      if (normalizedSource === normalizedSearch) {
        return source;
      }
    }

    // Second, try matching by filename + parent directory (more specific than just filename)
    const searchParts = normalizedSearch.split('/');
    if (searchParts.length >= 2) {
      const searchSuffix = searchParts.slice(-2).join('/');
      for (const source of sources) {
        const normalizedSource = this.normalizePath(source);
        if (normalizedSource.endsWith(searchSuffix)) {
          return source;
        }
      }
    }

    // Third, try matching by exact filename only (least specific, but still requires exact filename match)
    for (const source of sources) {
      const sourceBasename = path.basename(this.normalizePath(source));
      if (sourceBasename === searchBasename) {
        return source;
      }
    }

    return undefined;
  }

  /**
   * Normalize a path for comparison
   */
  private normalizePath(p: string): string {
    // Remove webpack:// or similar prefixes
    let normalized = p.replace(/^webpack:\/\/[^/]*\//, '');
    normalized = normalized.replace(/^file:\/\//, '');
    normalized = normalized.replace(/^\.\//g, '');
    // Normalize path separators
    normalized = normalized.replace(/\\/g, '/');
    // Remove leading ./
    while (normalized.startsWith('./')) {
      normalized = normalized.slice(2);
    }
    return normalized;
  }

  /**
   * Map a TypeScript position to JavaScript position (for setting breakpoints)
   */
  async mapToGenerated(
    originalSource: string,
    originalLine: number,
    originalColumn: number = 0
  ): Promise<{ generatedFile: string; line: number; column: number } | null> {
    if (this.clearing) return null;

    // First, check already-loaded source maps
    for (const [generatedFile, consumer] of this.sourceMaps.entries()) {
      if (this.clearing) return null;

      const sources = (consumer as any).sources as string[] | undefined;
      if (!sources) continue;

      const matchingSource = this.findMatchingSource(sources, originalSource);

      if (matchingSource) {
        const generated = consumer.generatedPositionFor({
          source: matchingSource,
          line: originalLine,
          column: originalColumn,
        });

        if (generated.line !== null && generated.column !== null) {
          return {
            generatedFile,
            line: generated.line,
            column: generated.column,
          };
        }
      }
    }

    // Lazy load: try pending source maps if not found in loaded ones
    // Copy keys to avoid mutating map during iteration
    const pendingKeys = Array.from(this.pendingSourceMaps.keys());
    for (const scriptUrl of pendingKeys) {
      if (this.clearing) return null;

      const sourceMapURL = this.pendingSourceMaps.get(scriptUrl);
      if (!sourceMapURL) continue; // already processed by another call

      await this.loadSourceMapFromURL(scriptUrl, sourceMapURL);
      this.pendingSourceMaps.delete(scriptUrl);

      const consumer = this.sourceMaps.get(scriptUrl);
      if (consumer) {
        const sources = (consumer as any).sources as string[] | undefined;
        if (!sources) continue;

        const matchingSource = this.findMatchingSource(sources, originalSource);

        if (matchingSource) {
          const generated = consumer.generatedPositionFor({
            source: matchingSource,
            line: originalLine,
            column: originalColumn,
          });

          if (generated.line !== null && generated.column !== null) {
            return {
              generatedFile: scriptUrl,
              line: generated.line,
              column: generated.column,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Map a JavaScript position to TypeScript position (for displaying location)
   */
  async mapToOriginal(
    generatedFile: string,
    generatedLine: number,
    generatedColumn: number = 0
  ): Promise<SourcePosition | null> {
    if (this.clearing) return null;

    let consumer = this.sourceMaps.get(generatedFile);

    // Lazy load: if not loaded but registered, load now
    if (!consumer && this.pendingSourceMaps.has(generatedFile)) {
      const sourceMapURL = this.pendingSourceMaps.get(generatedFile)!;
      await this.loadSourceMapFromURL(generatedFile, sourceMapURL);
      this.pendingSourceMaps.delete(generatedFile);
      consumer = this.sourceMaps.get(generatedFile);
    }

    if (!consumer || this.clearing) {
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
   * Load source map from URL or data URI (with proper concurrency handling)
   */
  async loadSourceMapFromURL(scriptUrl: string, sourceMapURL: string): Promise<void> {
    if (this.clearing) return;

    // Already loaded
    if (this.sourceMaps.has(scriptUrl)) {
      return;
    }

    // Already loading - wait for existing load to complete
    const existingPromise = this.loadingPromises.get(scriptUrl);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    // Create and store the loading promise
    const loadPromise = this.doLoadSourceMap(scriptUrl, sourceMapURL);
    this.loadingPromises.set(scriptUrl, loadPromise);

    try {
      await loadPromise;
    } finally {
      this.loadingPromises.delete(scriptUrl);
    }
  }

  /**
   * Internal: Actually load the source map
   */
  private async doLoadSourceMap(scriptUrl: string, sourceMapURL: string): Promise<void> {
    try {
      // Handle inline data URLs (data:application/json;base64,... or with charset)
      if (sourceMapURL.startsWith('data:')) {
        // More flexible regex: handles optional charset parameter
        const match = sourceMapURL.match(/^data:application\/json(?:;charset=[^;]+)?;base64,(.+)$/);
        if (match) {
          const base64Data = match[1];

          // Skip oversized inline source maps to prevent performance issues
          if (base64Data.length > MAX_INLINE_SOURCEMAP_SIZE) {
            this.recordError(scriptUrl, `Inline source map too large: ${base64Data.length} chars (max ${MAX_INLINE_SOURCEMAP_SIZE})`);
            return;
          }

          const jsonData = Buffer.from(base64Data, 'base64').toString('utf-8');
          const rawSourceMap = this.parseSourceMapJSON(jsonData, scriptUrl);
          if (!rawSourceMap) return;

          const consumer = await new SourceMapConsumer(rawSourceMap);
          if (!this.clearing) {
            this.sourceMaps.set(scriptUrl, consumer);
            debugLog('sourcemap', `Loaded inline source map for ${scriptUrl}`);
          } else {
            consumer.destroy();
          }
          return;
        }

        // Handle non-base64 data URIs (URL-encoded)
        const nonBase64Match = sourceMapURL.match(/^data:application\/json(?:;charset=[^;]+)?,(.+)$/);
        if (nonBase64Match) {
          try {
            const jsonData = decodeURIComponent(nonBase64Match[1]);
            if (jsonData.length > MAX_INLINE_SOURCEMAP_SIZE) {
              this.recordError(scriptUrl, `Inline source map too large: ${jsonData.length} chars`);
              return;
            }
            const rawSourceMap = this.parseSourceMapJSON(jsonData, scriptUrl);
            if (!rawSourceMap) return;

            const consumer = await new SourceMapConsumer(rawSourceMap);
            if (!this.clearing) {
              this.sourceMaps.set(scriptUrl, consumer);
              debugLog('sourcemap', `Loaded inline source map for ${scriptUrl}`);
            } else {
              consumer.destroy();
            }
            return;
          } catch {
            this.recordError(scriptUrl, 'Failed to decode non-base64 data URI');
            return;
          }
        }

        this.recordError(scriptUrl, 'Unrecognized data URI format');
        return;
      }

      // Handle relative URLs - convert to absolute file path
      let mapPath: string;
      if (sourceMapURL.startsWith('http://') || sourceMapURL.startsWith('https://')) {
        // For HTTP URLs, extract the path component and treat as local file
        // Note: This is a best-effort heuristic for local development
        const url = new URL(sourceMapURL);
        mapPath = url.pathname;
        if (mapPath.startsWith('/')) {
          mapPath = path.join(process.cwd(), mapPath.slice(1));
        }
      } else {
        // Relative path - resolve relative to the script
        const scriptPath = scriptUrl.replace(/^https?:\/\/[^/]+/, '');
        const scriptDir = path.dirname(scriptPath);
        mapPath = path.join(process.cwd(), scriptDir, sourceMapURL);
      }

      // Check file size before reading
      let stats;
      try {
        stats = await fs.stat(mapPath);
      } catch {
        // File doesn't exist - this is common and not an error worth reporting
        return;
      }

      if (stats.size > MAX_FILE_SOURCEMAP_SIZE) {
        this.recordError(scriptUrl, `Source map file too large: ${stats.size} bytes (max ${MAX_FILE_SOURCEMAP_SIZE})`);
        return;
      }

      // Load the source map file
      const mapContent = await fs.readFile(mapPath, 'utf-8');
      const rawSourceMap = this.parseSourceMapJSON(mapContent, scriptUrl);
      if (!rawSourceMap) return;

      const consumer = await new SourceMapConsumer(rawSourceMap);
      if (!this.clearing) {
        this.sourceMaps.set(scriptUrl, consumer);
        debugLog('sourcemap', `Loaded source map for ${scriptUrl} from ${mapPath}`);
      } else {
        consumer.destroy();
      }
    } catch (error) {
      this.recordError(scriptUrl, String(error));
      debugLog('sourcemap', `Could not load source map for ${scriptUrl}: ${error}`);
    }
  }

  /**
   * Parse source map JSON with error tracking
   */
  private parseSourceMapJSON(json: string, scriptUrl: string): any | null {
    try {
      const parsed = JSON.parse(json);
      // Basic validation
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

  /**
   * Record an error for later inspection
   */
  private recordError(scriptUrl: string, error: string): void {
    this.lastErrors.push({
      scriptUrl,
      error,
      timestamp: Date.now(),
    });
    // Keep only last 20 errors
    if (this.lastErrors.length > 20) {
      this.lastErrors.shift();
    }
  }

  /**
   * Get recent source map loading errors (for debugging)
   */
  getRecentErrors(): LoadError[] {
    return [...this.lastErrors];
  }

  /**
   * Clear error history
   */
  clearErrors(): void {
    this.lastErrors = [];
  }

  /**
   * Register source maps from a directory for lazy loading (does NOT eagerly load)
   */
  async registerSourceMapsFromDirectory(directory: string): Promise<number> {
    if (this.clearing) return 0;

    let registered = 0;
    try {
      const entries = await fs.readdir(directory, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
          // Recurse into subdirectories
          registered += await this.registerSourceMapsFromDirectory(fullPath);
        } else if (entry.name.endsWith('.js.map')) {
          // Register the source map for the corresponding JS file
          const jsPath = fullPath.slice(0, -4); // Remove .map
          this.pendingSourceMaps.set(jsPath, fullPath);
          registered++;
        }
      }
    } catch (error) {
      debugLog('sourcemap', `Could not scan directory ${directory}: ${error}`);
    }
    return registered;
  }

  /**
   * Force reload a source map (clear and re-register for lazy loading)
   */
  forceReload(scriptUrl: string, sourceMapURL?: string): void {
    // Clear existing
    const consumer = this.sourceMaps.get(scriptUrl);
    if (consumer) {
      consumer.destroy();
      this.sourceMaps.delete(scriptUrl);
    }

    // Re-register for lazy loading if URL provided
    if (sourceMapURL) {
      this.pendingSourceMaps.set(scriptUrl, sourceMapURL);
    }
  }

  /**
   * Clear all loaded and pending source maps (safe for concurrent operations)
   */
  clear(): void {
    this.clearing = true;

    // Wait for any in-flight loads to notice the clearing flag
    // They will destroy their consumers themselves

    for (const consumer of this.sourceMaps.values()) {
      consumer.destroy();
    }
    this.sourceMaps.clear();
    this.pendingSourceMaps.clear();
    this.loadingPromises.clear();
    this.lastErrors = [];

    this.clearing = false;
  }

  /**
   * Clear a specific source map (loaded or pending)
   */
  clearSourceMap(scriptUrl: string): boolean {
    const consumer = this.sourceMaps.get(scriptUrl);
    if (consumer) {
      consumer.destroy();
      this.sourceMaps.delete(scriptUrl);
      return true;
    }
    if (this.pendingSourceMaps.has(scriptUrl)) {
      this.pendingSourceMaps.delete(scriptUrl);
      return true;
    }
    return false;
  }

  /**
   * Get all loaded source map files
   */
  getLoadedSourceMaps(): string[] {
    return Array.from(this.sourceMaps.keys());
  }

  /**
   * Check if a source map is loaded or registered for a given file
   */
  hasSourceMap(file: string): boolean {
    return this.sourceMaps.has(file) || this.pendingSourceMaps.has(file);
  }

  /**
   * Check if a source map is actually loaded (not just registered)
   */
  isSourceMapLoaded(file: string): boolean {
    return this.sourceMaps.has(file);
  }

  /**
   * Get all registered (pending) source map URLs
   */
  getPendingSourceMaps(): string[] {
    return Array.from(this.pendingSourceMaps.keys());
  }
}
