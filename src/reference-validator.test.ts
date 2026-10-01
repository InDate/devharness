/**
 * Unit tests for reference validation
 */

import { describe, it, expect } from 'vitest';
import {
  validateReference,
  sanitizeReference,
  UNNAMED_CONNECTION,
  RESERVED_REFERENCES,
} from './reference-validator.js';

describe('sanitizeReference', () => {
  it('should convert to lowercase', () => {
    expect(sanitizeReference('Test Payment Flow')).toBe('test-payment-flow');
  });

  it('should trim whitespace', () => {
    expect(sanitizeReference('  test payment flow  ')).toBe('test-payment-flow');
  });

  it('should replace multiple spaces with single hyphen', () => {
    expect(sanitizeReference('test  payment  flow')).toBe('test-payment-flow');
    expect(sanitizeReference('test   payment   flow')).toBe('test-payment-flow');
  });

  it('should handle tabs and newlines as whitespace', () => {
    expect(sanitizeReference('test\tpayment\nflow')).toBe('test-payment-flow');
  });

  it('should handle mixed case', () => {
    expect(sanitizeReference('TeSt PaYmEnT fLoW')).toBe('test-payment-flow');
  });
});

describe('validateReference', () => {
  describe('valid references', () => {
    it('should accept exactly 3 words', () => {
      const result = validateReference('test payment flow');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('test-payment-flow');
      expect(result.error).toBeUndefined();
    });

    it('should accept 3 words with extra whitespace', () => {
      const result = validateReference('  test   payment   flow  ');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('test-payment-flow');
    });

    it('should accept 3 words with mixed case', () => {
      const result = validateReference('Test Payment Flow');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('test-payment-flow');
    });

    it('should accept 3 words with tabs and newlines', () => {
      const result = validateReference('test\tpayment\nflow');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('test-payment-flow');
    });

    it('should accept already-sanitized 3-part references', () => {
      const result = validateReference('test-payment-flow');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('test-payment-flow');
    });

    it('should accept already-sanitized references with uppercase', () => {
      const result = validateReference('Test-Payment-Flow');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('test-payment-flow');
    });
  });

  describe('invalid word count', () => {
    it('should reject 1 word', () => {
      const result = validateReference('oneword');
      expect(result.valid).toBe(false);
      expect(result.sanitized).toBeUndefined();
      expect(result.error).toBe('Connection name "oneword" must be exactly 3 words, got 1');
    });

    it('should reject 2 words', () => {
      const result = validateReference('two words');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name "two words" must be exactly 3 words, got 2');
    });

    it('should reject 4 words', () => {
      const result = validateReference('four words too many');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name "four words too many" must be exactly 3 words, got 4');
    });

    it('should reject 5+ words', () => {
      const result = validateReference('this has way too many words here');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name "this has way too many words here" must be exactly 3 words, got 7');
    });
  });

  describe('empty input', () => {
    it('should reject empty string', () => {
      const result = validateReference('');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name cannot be empty');
    });

    it('should reject whitespace-only string', () => {
      const result = validateReference('   ');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name cannot be empty');
    });

    it('should reject tabs and newlines only', () => {
      const result = validateReference('\t\n  \t');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name cannot be empty');
    });
  });

  describe('reserved words', () => {
    it('should reject "no reference set"', () => {
      const result = validateReference('no reference set');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved and cannot be used');
    });

    it('should reject "none none none"', () => {
      const result = validateReference('none none none');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved and cannot be used');
    });

    it('should reject "unknown connection type"', () => {
      const result = validateReference('unknown connection type');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved and cannot be used');
    });

    it('should reject "unnamed connection default"', () => {
      const result = validateReference('unnamed connection default');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved and cannot be used');
    });

    it('should reject reserved words with different case', () => {
      const result = validateReference('No Reference Set');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved and cannot be used');
    });

    it('should reject reserved words with extra whitespace', () => {
      const result = validateReference('  no   reference   set  ');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved and cannot be used');
    });

    it('should verify reserved words are in hyphenated form', () => {
      expect(RESERVED_REFERENCES).toContain('no-reference-set');
      expect(RESERVED_REFERENCES).toContain('none-none-none');
      expect(RESERVED_REFERENCES).toContain('unknown-connection-type');
      expect(RESERVED_REFERENCES).toContain(UNNAMED_CONNECTION);
    });
  });

  describe('bypass prevention', () => {
    it('should prevent whitespace bypass for duplicates', () => {
      // This was the critical bug: "test payment flow" and "test  payment  flow"
      // would both become "test-payment-flow" but only the first would be caught
      const ref1 = validateReference('test payment flow');
      const ref2 = validateReference('test  payment  flow');

      expect(ref1.valid).toBe(true);
      expect(ref2.valid).toBe(true);
      expect(ref1.sanitized).toBe(ref2.sanitized);
      expect(ref1.sanitized).toBe('test-payment-flow');
    });

    it('should prevent case bypass for duplicates', () => {
      const ref1 = validateReference('test payment flow');
      const ref2 = validateReference('Test Payment Flow');

      expect(ref1.valid).toBe(true);
      expect(ref2.valid).toBe(true);
      expect(ref1.sanitized).toBe(ref2.sanitized);
    });

    it('should prevent reserved word bypass with whitespace', () => {
      // This was the critical bug: "no  reference  set" with extra spaces
      // would pass validation but become "no-reference-set"
      const result = validateReference('no  reference  set');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved and cannot be used');
    });

    it('should prevent reserved word bypass with case', () => {
      const result = validateReference('NO REFERENCE SET');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved and cannot be used');
    });
  });

  describe('edge cases', () => {
    it('should handle unicode characters', () => {
      const result = validateReference('café résumé naïve');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('café-résumé-naïve');
    });

    it('should handle numbers', () => {
      const result = validateReference('test user 123');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('test-user-123');
    });

    it('should handle special characters in words', () => {
      const result = validateReference('user@123 payment#flow test_case');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('user@123-payment#flow-test_case');
    });

    it('should handle emoji', () => {
      const result = validateReference('test 🎉 flow');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('test-🎉-flow');
    });

    it('should handle very long words', () => {
      const longWord = 'a'.repeat(100);
      const result = validateReference(`${longWord} test flow`);
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe(`${longWord}-test-flow`);
    });
  });

  describe('sanitized format validation', () => {
    it('should ensure sanitized version has exactly 3 parts', () => {
      // Normal case: 3 words -> 3 hyphenated parts
      const result1 = validateReference('test payment flow');
      expect(result1.valid).toBe(true);
      expect(result1.sanitized?.split('-').length).toBe(3);
    });

    it('should catch edge cases where sanitization creates different part count', () => {
      // This is a safety check in case sanitization behaves unexpectedly
      // The current implementation should always produce 3 parts for valid input
      const result = validateReference('test payment flow');
      expect(result.valid).toBe(true);

      const parts = result.sanitized!.split('-');
      expect(parts.length).toBe(3);
      expect(parts[0]).toBe('test');
      expect(parts[1]).toBe('payment');
      expect(parts[2]).toBe('flow');
    });
  });

  describe('real-world examples', () => {
    it('should accept debugging payment flow', () => {
      const result = validateReference('debugging payment flow');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('debugging-payment-flow');
    });

    it('should accept testing api endpoints', () => {
      const result = validateReference('testing api endpoints');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('testing-api-endpoints');
    });

    it('should accept search wikipedia results', () => {
      const result = validateReference('search wikipedia results');
      expect(result.valid).toBe(true);
      expect(result.sanitized).toBe('search-wikipedia-results');
    });

    it('should accept hyphenated 3-part references', () => {
      // These are now valid since we accept already-sanitized references
      const result1 = validateReference('nodejs-api-server');
      expect(result1.valid).toBe(true);
      expect(result1.sanitized).toBe('nodejs-api-server');
    });

    it('should reject 2-part hyphenated references', () => {
      const result = validateReference('chrome-browser');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name "chrome-browser" must be exactly 3 words, got 2');
    });
  });
});
