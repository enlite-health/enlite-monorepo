/**
 * AttentionReason — Unit Tests
 *
 * Verifies that all enum members are present in the canonical array
 * and that isAttentionReason acts as a proper type-guard.
 */

import { ATTENTION_REASONS, isAttentionReason } from '../AttentionReason';

describe('ATTENTION_REASONS', () => {
  it('contains MISSING_INFO', () => {
    expect(ATTENTION_REASONS).toContain('MISSING_INFO');
  });

  it('contains CASE_NUMBER_CONFLICT', () => {
    expect(ATTENTION_REASONS).toContain('CASE_NUMBER_CONFLICT');
  });
});

describe('isAttentionReason', () => {
  it('returns true for MISSING_INFO', () => {
    expect(isAttentionReason('MISSING_INFO')).toBe(true);
  });

  it('returns true for CASE_NUMBER_CONFLICT', () => {
    expect(isAttentionReason('CASE_NUMBER_CONFLICT')).toBe(true);
  });

  it('returns false for unknown string', () => {
    expect(isAttentionReason('INVALID_REASON')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isAttentionReason(null)).toBe(false);
    expect(isAttentionReason(undefined)).toBe(false);
    expect(isAttentionReason(42)).toBe(false);
    expect(isAttentionReason({})).toBe(false);
  });
});
