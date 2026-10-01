/**
 * Reference validation utilities
 */

import { createErrorResponse } from './messages.js';

// Constants
export const UNNAMED_CONNECTION = 'unnamed-connection-default';
/** The one fourth word a connection name takes: the proxied connection made from a three-word one. */
export const PROXIED_WORD = 'proxied';
export const RESERVED_REFERENCES = [
  UNNAMED_CONNECTION,
  'no-reference-set',
  'unknown-connection-type',
  'none-none-none',
];

/**
 * Sanitize a reference string to a consistent format
 * Converts "Test Payment Flow" -> "test-payment-flow"
 */
export function sanitizeReference(ref: string): string {
  return ref.toLowerCase().trim().replace(/\s+/g, '-');
}

/**
 * Derive a valid 3-word connection reference from an arbitrary name (e.g. a
 * sequence filename), which has no guaranteed word count. Deterministic per
 * input name, so repeated runs of the same sequence reuse the same reference.
 */
export function deriveConnectionReference(name: string): string {
  const parts = sanitizeReference(name).split('-').filter(Boolean);
  if (parts.length === 3) return parts.join('-');
  if (parts.length > 3) return `${parts[0]}-${parts[1]}-run`;
  return [...parts, 'seq', 'run'].slice(0, 3).join('-');
}

/**
 * Validate a reference string (legacy API)
 * Returns the sanitized reference if valid, or an error if invalid
 *
 * Accepts both formats:
 * - "test replay feature" (3 space-separated words)
 * - "test-replay-feature" (already sanitized, 3 hyphen-separated parts)
 */
export function validateReference(ref: string): { valid: boolean; sanitized?: string; error?: string } {
  const trimmed = ref.trim();

  if (!trimmed) {
    return { valid: false, error: 'Connection name cannot be empty' };
  }

  // First, sanitize the reference
  const sanitized = sanitizeReference(ref);

  // Check for reserved words on sanitized version
  if (RESERVED_REFERENCES.includes(sanitized)) {
    return { valid: false, error: `Connection name "${trimmed}" is reserved and cannot be used` };
  }

  // Three words, spaces or hyphens alike; a fourth only as `proxied`, which
  // names the proxied connection made from a three-word one.
  const sanitizedParts = sanitized.split('-');
  const proxiedFourth = sanitizedParts.length === 4 && sanitizedParts[3] === PROXIED_WORD;
  if (sanitizedParts.length !== 3 && !proxiedFourth) {
    return { valid: false, error: `Connection name "${trimmed}" must be exactly 3 words, or 3 and "${PROXIED_WORD}", got ${sanitizedParts.length}` };
  }

  // Verify each part is non-empty (catches cases like "test--feature" or "test- -feature")
  if (sanitizedParts.some(part => !part)) {
    return { valid: false, error: `Connection name "${trimmed}" contains an empty word` };
  }

  return { valid: true, sanitized };
}

/**
 * Error class for invalid references - contains the MCP error response
 */
export class InvalidReferenceError extends Error {
  public readonly response: ReturnType<typeof createErrorResponse>;

  constructor(error: string, parameter: string) {
    super(error);
    this.name = 'InvalidReferenceError';
    this.response = createErrorResponse('INVALID_REFERENCE', { error, parameter });
  }
}

/**
 * Validate and return sanitized reference, or throw InvalidReferenceError
 * Use this in tool handlers - throws if invalid, returns sanitized string if valid
 */
export function requireValidReference(ref: string, parameter: 'connection' | 'newName'): string {
  const result = validateReference(ref);
  if (!result.valid) {
    throw new InvalidReferenceError(result.error!, parameter);
  }
  return result.sanitized!;
}
