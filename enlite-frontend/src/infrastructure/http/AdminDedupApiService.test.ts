/**
 * AdminDedupApiService.test.ts
 *
 * Tests the REAL service class (not mocked).
 * Only fetch and FirebaseAuthService are stubbed.
 *
 * Covers:
 * - Authorization header is set using token from FirebaseAuthService
 * - No Authorization header when token is null
 * - {success:true, data} response → returns data
 * - {success:false, error} response → throws Error with message
 * - getGroups  → GET /api/admin/dedup/groups
 * - getGroupDetail → GET /api/admin/dedup/groups/:encoded
 *   (verifies encodeURIComponent is applied to the phone)
 * - merge → POST /api/admin/dedup/merge with JSON body
 * - dismiss → POST /api/admin/dedup/dismiss with JSON body
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DedupGroupSummary, DedupGroupDetail, MergeRequest, DismissRequest } from '@domain/entities/DedupGroup';

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Use vi.hoisted so the mock factory can reference the fn before module evaluation.
const { mockGetIdToken } = vi.hoisted(() => ({
  mockGetIdToken: vi.fn<[], Promise<string | null>>(),
}));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: mockGetIdToken,
  })),
}));

// We import the module AFTER mocking so the constructor picks up the mock.
import { AdminDedupApiService } from './AdminDedupApiService';

// ── Helpers ───────────────────────────────────────────────────────────────────

let originalFetch: typeof globalThis.fetch;

function mockFetchSuccess<T>(data: T): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    json: async () => ({ success: true, data }),
  });
}

function mockFetchError(error: string): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    status: 422,
    json: async () => ({ success: false, error }),
  });
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_GROUPS: DedupGroupSummary[] = [
  {
    phone_normalized: '+5491112345678',
    accounts: [],
    survivor_suggested: 'acc-001',
  },
];

const MOCK_DETAIL: DedupGroupDetail = {
  phone_normalized: '+5491112345678',
  accounts: [],
  survivor_suggested: 'acc-001',
  field_comparisons: [],
  reparent_preview: [],
};

const MOCK_MERGE_RESULT = {
  survivorId: 'acc-001',
  absorbedIds: ['acc-002'],
  mergedAt: '2026-06-22T00:00:00Z',
};

const MOCK_DISMISS_RESULT = {
  phoneNormalized: '+5491112345678',
  dismissedAt: '2026-06-22T00:00:00Z',
};

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mockGetIdToken.mockResolvedValue('test-token-xyz');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

// ── Authorization header ──────────────────────────────────────────────────────

describe('AdminDedupApiService — Authorization header', () => {
  it('sends Authorization: Bearer <token> when token is available', async () => {
    mockGetIdToken.mockResolvedValue('my-firebase-token');
    mockFetchSuccess(MOCK_GROUPS);

    await AdminDedupApiService.getGroups();

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = fetchCall[1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-firebase-token');
  });

  it('does NOT include Authorization header when token is null', async () => {
    mockGetIdToken.mockResolvedValue(null);
    mockFetchSuccess(MOCK_GROUPS);

    await AdminDedupApiService.getGroups();

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = fetchCall[1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('always sets Content-Type: application/json', async () => {
    mockFetchSuccess(MOCK_GROUPS);
    await AdminDedupApiService.getGroups();

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = fetchCall[1]?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});

// ── Response parsing ──────────────────────────────────────────────────────────

describe('AdminDedupApiService — response parsing', () => {
  it('returns data when success=true', async () => {
    mockFetchSuccess(MOCK_GROUPS);
    const result = await AdminDedupApiService.getGroups();
    expect(result).toEqual(MOCK_GROUPS);
  });

  it('throws Error with message when success=false', async () => {
    mockFetchError('Unauthorized access');
    await expect(AdminDedupApiService.getGroups()).rejects.toThrow('Unauthorized access');
  });

  it('throws with HTTP status fallback when error field is missing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 500,
      json: async () => ({ success: false, error: '' }),
    });
    await expect(AdminDedupApiService.getGroups()).rejects.toThrow('HTTP 500');
  });
});

// ── getGroups ─────────────────────────────────────────────────────────────────

describe('AdminDedupApiService.getGroups', () => {
  it('makes GET request to /api/admin/dedup/groups', async () => {
    mockFetchSuccess(MOCK_GROUPS);
    await AdminDedupApiService.getGroups();

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const options = fetchCall[1];
    expect(url).toContain('/api/admin/dedup/groups');
    expect(options?.method).toBe('GET');
  });

  it('returns array of groups', async () => {
    mockFetchSuccess(MOCK_GROUPS);
    const result = await AdminDedupApiService.getGroups();
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].phone_normalized).toBe('+5491112345678');
  });
});

// ── getGroupDetail ────────────────────────────────────────────────────────────

describe('AdminDedupApiService.getGroupDetail', () => {
  it('makes GET request to /api/admin/dedup/groups/:encoded', async () => {
    mockFetchSuccess(MOCK_DETAIL);
    const phone = '+5491112345678';
    await AdminDedupApiService.getGroupDetail(phone);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const options = fetchCall[1];
    expect(url).toContain('/api/admin/dedup/groups/');
    expect(options?.method).toBe('GET');
  });

  it('applies encodeURIComponent to the phone number', async () => {
    mockFetchSuccess(MOCK_DETAIL);
    const phone = '+5491112345678';
    await AdminDedupApiService.getGroupDetail(phone);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    // '+' must be encoded as '%2B'
    expect(url).toContain(encodeURIComponent(phone));
    expect(url).toContain('%2B');
  });

  it('returns DedupGroupDetail', async () => {
    mockFetchSuccess(MOCK_DETAIL);
    const result = await AdminDedupApiService.getGroupDetail('+5491112345678');
    expect(result.phone_normalized).toBe('+5491112345678');
  });
});

// ── merge ─────────────────────────────────────────────────────────────────────

describe('AdminDedupApiService.merge', () => {
  it('makes POST request to /api/admin/dedup/merge', async () => {
    mockFetchSuccess(MOCK_MERGE_RESULT);
    const payload: MergeRequest = {
      survivorId: 'acc-001',
      absorbedIds: ['acc-002'],
    };
    await AdminDedupApiService.merge(payload);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const options = fetchCall[1];
    expect(url).toContain('/api/admin/dedup/merge');
    expect(options?.method).toBe('POST');
  });

  it('sends payload as JSON body', async () => {
    mockFetchSuccess(MOCK_MERGE_RESULT);
    const payload: MergeRequest = {
      survivorId: 'acc-001',
      absorbedIds: ['acc-002'],
      fieldChoices: { email: 'acc-001' },
    };
    await AdminDedupApiService.merge(payload);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = fetchCall[1]?.body as string;
    const parsed = JSON.parse(body);
    expect(parsed).toEqual(payload);
  });

  it('returns MergeResult', async () => {
    mockFetchSuccess(MOCK_MERGE_RESULT);
    const result = await AdminDedupApiService.merge({
      survivorId: 'acc-001',
      absorbedIds: ['acc-002'],
    });
    expect(result.survivorId).toBe('acc-001');
    expect(result.absorbedIds).toContain('acc-002');
  });
});

// ── dismiss ───────────────────────────────────────────────────────────────────

describe('AdminDedupApiService.dismiss', () => {
  it('makes POST request to /api/admin/dedup/dismiss', async () => {
    mockFetchSuccess(MOCK_DISMISS_RESULT);
    const payload: DismissRequest = { phoneNormalized: '+5491112345678' };
    await AdminDedupApiService.dismiss(payload);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const options = fetchCall[1];
    expect(url).toContain('/api/admin/dedup/dismiss');
    expect(options?.method).toBe('POST');
  });

  it('sends payload as JSON body', async () => {
    mockFetchSuccess(MOCK_DISMISS_RESULT);
    const payload: DismissRequest = {
      phoneNormalized: '+5491112345678',
      reason: 'not_a_dup',
    };
    await AdminDedupApiService.dismiss(payload);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = fetchCall[1]?.body as string;
    const parsed = JSON.parse(body);
    expect(parsed).toEqual(payload);
  });

  it('returns DismissResult', async () => {
    mockFetchSuccess(MOCK_DISMISS_RESULT);
    const result = await AdminDedupApiService.dismiss({
      phoneNormalized: '+5491112345678',
    });
    expect(result.phoneNormalized).toBe('+5491112345678');
  });
});
