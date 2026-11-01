/**
 * Unit tests for reference validation
 */

import { describe, it, expect } from 'vitest';
import {
  validateReference,
  sanitizeReference,
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
      expect(result.error).toBe('Connection name "oneword" must be exactly 3 words, or 3 and "proxied", got 1');
    });

    it('should reject 2 words', () => {
      const result = validateReference('two words');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name "two words" must be exactly 3 words, or 3 and "proxied", got 2');
    });

    it('should reject 4 words', () => {
      const result = validateReference('four words too many');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name "four words too many" must be exactly 3 words, or 3 and "proxied", got 4');
    });

    it('accepts a fourth word only when it is proxied', () => {
      expect(validateReference('user one join proxied')).toEqual({ valid: true, sanitized: 'user-one-join-proxied' });
      expect(validateReference('user-one-join-proxied').valid).toBe(true);
      expect(validateReference('user-one-join-direct').valid).toBe(false);
      expect(validateReference('proxied-user-one-join').valid).toBe(false);
    });

    it('should reject 5+ words', () => {
      const result = validateReference('this has way too many words here');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name "this has way too many words here" must be exactly 3 words, or 3 and "proxied", got 7');
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

  describe('real-world examples', () => {
    it('should reject 2-part hyphenated references', () => {
      const result = validateReference('chrome-browser');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Connection name "chrome-browser" must be exactly 3 words, or 3 and "proxied", got 2');
    });
  });
});
