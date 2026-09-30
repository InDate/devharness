/**
 * Download Tools
 * Tools for downloading files from URLs with security and quarantine features
 */

import { z } from 'zod';
import { createTool } from '../validation-helpers.js';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { promises as fs } from 'fs';
import { join, basename, normalize } from 'path';
import { getOutputPath } from '../helpers/paths.js';

// Computed fresh on each call (not cached) so they follow a later
// setWorkingDirOverride() / config useLocal(path) switch.
function getDownloadsDir(): string {
  return getOutputPath('downloads');
}
function getQuarantineDir(): string {
  return join(getDownloadsDir(), 'quarantine');
}

// Security limits
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const SUSPICIOUS_EXTENSIONS = ['.exe', '.dll', '.so', '.dylib', '.bin', '.app', '.bat', '.cmd', '.sh', '.ps1', '.vbs', '.scr'];
const ALLOWED_CONTENT_TYPES = ['image/', 'text/', 'application/json', 'application/xml', 'application/pdf', 'application/javascript', 'application/typescript'];

interface QuarantineEntry {
  filename: string;
  url: string;
  reason: string;
  size: number;
  contentType: string | null;
  timestamp: string;
}

// In-memory quarantine registry
const quarantineRegistry: QuarantineEntry[] = [];

/**
 * Validate filename for security (prevent path traversal)
 */
function validateFilename(filename: string): { valid: boolean; error?: string } {
  // Check for path traversal attempts
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return { valid: false, error: 'Filename cannot contain path separators or parent directory references' };
  }

  // Check for null bytes
  if (filename.includes('\0')) {
    return { valid: false, error: 'Filename cannot contain null bytes' };
  }

  // Must have a filename
  if (!filename.trim()) {
    return { valid: false, error: 'Filename cannot be empty' };
  }

  // Normalize and check it matches original (catches various tricks)
  const normalized = basename(normalize(filename));
  if (normalized !== filename) {
    return { valid: false, error: 'Invalid filename format' };
  }

  return { valid: true };
}

/**
 * Check if file/content is suspicious
 */
function isSuspicious(filename: string, contentType: string | null): { suspicious: boolean; reason?: string } {
  // Check extension
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (ext && SUSPICIOUS_EXTENSIONS.includes(ext)) {
    return { suspicious: true, reason: `Suspicious file extension: ${ext}` };
  }

  // Check content type if available
  if (contentType) {
    const isAllowed = ALLOWED_CONTENT_TYPES.some(allowed => contentType.toLowerCase().startsWith(allowed));
    if (!isAllowed) {
      return { suspicious: true, reason: `Suspicious content-type: ${contentType}` };
    }
  }

  return { suspicious: false };
}

/**
 * Remove executable permissions from a file (security measure)
 */
async function removeExecutablePermissions(filepath: string): Promise<void> {
  try {
    // Set to read-only for owner, group, and others (0o444)
    await fs.chmod(filepath, 0o444);
  } catch (error) {
    // Ignore chmod errors (might not be supported on all platforms)
    console.error(`Warning: Could not remove executable permissions from ${filepath}:`, error);
  }
}

/**
 * Add file to quarantine
 */
async function quarantineFile(
  url: string,
  filename: string,
  reason: string,
  size: number,
  contentType: string | null,
  buffer: Buffer
): Promise<void> {
  const quarantineDir = getQuarantineDir();
  await fs.mkdir(quarantineDir, { recursive: true });

  // Add .quarantined extension to prevent execution on all platforms (especially Windows)
  const quarantinedFilename = `${filename}.quarantined`;
  const quarantinePath = join(quarantineDir, quarantinedFilename);
  await fs.writeFile(quarantinePath, buffer);

  // Remove executable permissions for security (Unix systems)
  await removeExecutablePermissions(quarantinePath);

  quarantineRegistry.push({
    filename: quarantinedFilename,
    url,
    reason,
    size,
    contentType,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Get quarantine summary for reporting
 */
export function getQuarantineSummary(): QuarantineEntry[] {
  return [...quarantineRegistry];
}

/**
 * Clear quarantine registry (called after reporting)
 */
export function clearQuarantineRegistry(): void {
  quarantineRegistry.length = 0;
}

/**
 * A response body read up to `maxBytes`. A body without content-length has
 * its size known only by reading, so the read stops at the limit rather than
 * holding the whole of it first.
 */
export async function readLimited(
  response: Response,
  maxBytes: number
): Promise<{ tooLarge: false; buffer: Buffer } | { tooLarge: true; bytes: number }> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) return { tooLarge: false, buffer: Buffer.alloc(0) };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true, bytes };
    }
    chunks.push(value);
  }
  return { tooLarge: false, buffer: Buffer.concat(chunks) };
}

/**
 * Download tools for saving files from URLs
 */
export function createDownloadTools() {
  return {
    download: createTool(
      'Download a file from a URL into the downloads directory; a suspicious file goes to quarantine instead',
      z.object({
        url: z.string().url().describe('URL to download'),
        filename: z.string().describe('Filename to save as'),
        overwriteIfExists: z.boolean().optional().describe('Overwrite if exists (default: false)'),
      }).strict(),
      async (args) => {
        try {
          // Validate filename
          const filenameValidation = validateFilename(args.filename);
          if (!filenameValidation.valid) {
            return createErrorResponse('INVALID_FILENAME', {
              filename: args.filename,
              reason: filenameValidation.error!
            });
          }

          // Ensure downloads directory exists
          const downloadsDir = getDownloadsDir();
          await fs.mkdir(downloadsDir, { recursive: true });

          const filepath = join(downloadsDir, args.filename);

          // Check if file already exists BEFORE fetching
          let existingFileStats = null;
          try {
            existingFileStats = await fs.stat(filepath);
          } catch {
            // File doesn't exist, which is fine
          }

          // If file exists and overwrite not allowed, return error BEFORE downloading
          if (existingFileStats && !args.overwriteIfExists) {
            // Do a HEAD request to get new file size without downloading
            let newFileSize = 'Unknown';
            try {
              const headResponse = await fetch(args.url, { method: 'HEAD' });
              if (headResponse.ok) {
                const contentLength = headResponse.headers.get('content-length');
                if (contentLength) {
                  newFileSize = `${(parseInt(contentLength) / 1024).toFixed(2)} KB`;
                }
              }
            } catch {
              // Ignore HEAD request failures, just show unknown size
            }

            const existingFileSizeKB = (existingFileStats.size / 1024).toFixed(2);
            return createErrorResponse('FILE_ALREADY_EXISTS', {
              filename: args.filename,
              filepath: filepath,
              existingSize: `${existingFileSizeKB} KB`,
              existingModified: existingFileStats.mtime.toISOString(),
              newSize: newFileSize,
              url: args.url
            });
          }

          // Fetch the URL
          const response = await fetch(args.url);

          if (!response.ok) {
            return createErrorResponse('FILE_DOWNLOAD_FAILED', {
              url: args.url,
              status: response.status.toString(),
              statusText: response.statusText
            });
          }

          // Check content-length header for size limits
          const contentLength = response.headers.get('content-length');
          const contentType = response.headers.get('content-type');

          if (contentLength) {
            const sizeBytes = parseInt(contentLength);
            if (sizeBytes > MAX_FILE_SIZE) {
              return createErrorResponse('FILE_TOO_LARGE', {
                url: args.url,
                size: `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`,
                maxSize: `${(MAX_FILE_SIZE / 1024 / 1024).toFixed(2)} MB`
              });
            }
          }

          const read = await readLimited(response, MAX_FILE_SIZE);
          if (read.tooLarge) {
            return createErrorResponse('FILE_TOO_LARGE', {
              url: args.url,
              size: `more than ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(2)} MB`,
              maxSize: `${(MAX_FILE_SIZE / 1024 / 1024).toFixed(2)} MB`
            });
          }
          const buffer = read.buffer;
          const actualSize = buffer.length;

          const newFileSizeKB = (actualSize / 1024).toFixed(2);

          // Check if file is suspicious
          const suspiciousCheck = isSuspicious(args.filename, contentType);
          if (suspiciousCheck.suspicious) {
            // Quarantine the file instead of saving to downloads
            await quarantineFile(args.url, args.filename, suspiciousCheck.reason!, actualSize, contentType, buffer);

            const quarantinedFilename = `${args.filename}.quarantined`;
            return createErrorResponse('FILE_QUARANTINED', {
              filename: quarantinedFilename,
              reason: suspiciousCheck.reason!,
              size: `${newFileSizeKB} KB`,
              contentType: contentType || 'Unknown',
              quarantinePath: join(getQuarantineDir(), quarantinedFilename)
            });
          }

          // Use atomic write with rename to avoid race conditions
          const tempFilepath = `${filepath}.tmp.${Date.now()}`;

          try {
            await fs.writeFile(tempFilepath, buffer);
            await fs.rename(tempFilepath, filepath);

            // Remove executable permissions for security
            await removeExecutablePermissions(filepath);
          } catch (saveError: any) {
            // Clean up temp file if it exists
            try {
              await fs.unlink(tempFilepath);
            } catch {
              // Ignore cleanup errors
            }

            return createErrorResponse('FILE_SAVE_FAILED', {
              filepath: filepath,
              error: saveError.message
            });
          }

          // Return appropriate message based on whether we overwrote
          if (existingFileStats && args.overwriteIfExists) {
            return createSuccessResponse('FILE_DOWNLOADED_OVERWROTE', {
              filename: args.filename,
              filepath: filepath,
              size: `${newFileSizeKB} KB`,
              url: args.url
            });
          } else {
            return createSuccessResponse('FILE_DOWNLOADED', {
              filename: args.filename,
              filepath: filepath,
              size: `${newFileSizeKB} KB`,
              url: args.url
            });
          }
        } catch (error: any) {
          // Differentiate between fetch and save errors
          if (error.cause?.code === 'ECONNREFUSED' || error.cause?.code === 'ENOTFOUND') {
            return createErrorResponse('FILE_DOWNLOAD_NETWORK_ERROR', {
              url: args.url,
              error: error.message
            });
          }

          return createErrorResponse('FILE_DOWNLOAD_FAILED', {
            url: args.url,
            error: error.message
          });
        }
      }
    ),
  };
}
