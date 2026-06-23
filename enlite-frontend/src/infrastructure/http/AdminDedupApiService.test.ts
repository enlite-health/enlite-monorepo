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
 * - getHistory → GET /api/admin/dedup/history
 * - undoMerge  → POST /api/admin/dedup/merges/:auditId/undo
 *   (verifies encodeURIComponent is applied to the auditId)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  DedupGroupSummary,
  DedupGroupDetail,
  MergeRequest,
  DismissRequest,
  MergeHistoryItem,
  ImportedDedupGroup,
} from '@domain/entities/DedupGroup';

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

const MOCK_HISTORY: MergeHistoryItem[] = [
  {
    audit_id: 1,
    survivor_id: 'acc-001',
    absorbed_id: 'acc-002',
    survivor_name: 'María González',
    absorbed_name: '(importado)',
    phone_normalized: '+5491112345678',
    category: 'firebase',
    created_at: '2026-06-22T10:00:00Z',
    can_undo: true,
  },
  {
    audit_id: 2,
    survivor_id: 'acc-003',
    absorbed_id: 'acc-004',
    survivor_name: 'Carlos López',
    absorbed_name: null,
    phone_normalized: '+5491187654321',
    category: 'most_complete',
    created_at: '2026-06-21T08:00:00Z',
    can_undo: false,
  },
];

const MOCK_UNDO_RESULT = {
  auditId: 'audit-001',
  restoredAt: '2026-06-22T11:00:00Z',
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

// ── getHistory ────────────────────────────────────────────────────────────────

describe('AdminDedupApiService.getHistory', () => {
  it('makes GET request to /api/admin/dedup/history', async () => {
    mockFetchSuccess(MOCK_HISTORY);
    await AdminDedupApiService.getHistory();

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const options = fetchCall[1];
    expect(url).toContain('/api/admin/dedup/history');
    expect(options?.method).toBe('GET');
  });

  it('returns array of MergeHistoryItem', async () => {
    mockFetchSuccess(MOCK_HISTORY);
    const result = await AdminDedupApiService.getHistory();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].audit_id).toBe(1);
    expect(result[0].can_undo).toBe(true);
    expect(result[1].can_undo).toBe(false);
  });

  it('returns empty array when no history', async () => {
    mockFetchSuccess([]);
    const result = await AdminDedupApiService.getHistory();
    expect(result).toEqual([]);
  });

  it('throws when success=false', async () => {
    mockFetchError('History fetch failed');
    await expect(AdminDedupApiService.getHistory()).rejects.toThrow(
      'History fetch failed',
    );
  });
});

// ── undoMerge ─────────────────────────────────────────────────────────────────

describe('AdminDedupApiService.undoMerge', () => {
  it('makes POST request to /api/admin/dedup/merges/:auditId/undo', async () => {
    mockFetchSuccess(MOCK_UNDO_RESULT);
    await AdminDedupApiService.undoMerge('audit-001');

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const options = fetchCall[1];
    expect(url).toContain('/api/admin/dedup/merges/');
    expect(url).toContain('/undo');
    expect(options?.method).toBe('POST');
  });

  it('applies encodeURIComponent to the auditId', async () => {
    mockFetchSuccess(MOCK_UNDO_RESULT);
    const auditId = 'audit/special+chars';
    await AdminDedupApiService.undoMerge(auditId);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    expect(url).toContain(encodeURIComponent(auditId));
  });

  it('returns UndoResult', async () => {
    mockFetchSuccess(MOCK_UNDO_RESULT);
    const result = await AdminDedupApiService.undoMerge('audit-001');
    expect(result.auditId).toBe('audit-001');
    expect(result.restoredAt).toBe('2026-06-22T11:00:00Z');
  });

  it('throws when success=false', async () => {
    mockFetchError('Cannot undo — window expired');
    await expect(AdminDedupApiService.undoMerge('audit-001')).rejects.toThrow(
      'Cannot undo — window expired',
    );
  });
});

// ── getImportedGroups ─────────────────────────────────────────────────────────

const MOCK_IMPORTED_ACCOUNT = {
  id: 'acc-imp-001',
  email: null,
  tier: 'PRE_REGISTER',
  status: 'INCOMPLETE',
  created_at: '2026-02-20T10:00:00Z',
  updated_at: '2026-02-20T10:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: false,
  is_imported: true,
};

const MOCK_IMPORTED_GROUPS: ImportedDedupGroup[] = [
  {
    accounts: [
      {
        ...MOCK_IMPORTED_ACCOUNT,
        id: 'acc-real-001',
        email: 'maria@example.com',
        tier: 'REGISTERED',
        login_real: true,
        is_imported: false,
        wja_count: 3,
        docs_count: 2,
        encuadres_count: 1,
      },
      MOCK_IMPORTED_ACCOUNT,
    ],
    survivor_suggested_id: 'acc-real-001',
    survivor_reason: 'real_account_absorbs_imported',
    has_real: true,
  },
];

describe('AdminDedupApiService.getImportedGroups', () => {
  it('makes GET request to /api/admin/dedup/imported-groups', async () => {
    mockFetchSuccess(MOCK_IMPORTED_GROUPS);
    await AdminDedupApiService.getImportedGroups();

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = fetchCall[0] as string;
    const options = fetchCall[1];
    expect(url).toContain('/api/admin/dedup/imported-groups');
    expect(options?.method).toBe('GET');
  });

  it('appends onlyWithReal=true by default', async () => {
    mockFetchSuccess(MOCK_IMPORTED_GROUPS);
    await AdminDedupApiService.getImportedGroups();

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain('onlyWithReal=true');
  });

  it('appends onlyWithReal=false when passed false', async () => {
    mockFetchSuccess(MOCK_IMPORTED_GROUPS);
    await AdminDedupApiService.getImportedGroups(false);

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain('onlyWithReal=false');
  });

  it('returns array of ImportedDedupGroup', async () => {
    mockFetchSuccess(MOCK_IMPORTED_GROUPS);
    const result = await AdminDedupApiService.getImportedGroups();
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].survivor_reason).toBe('real_account_absorbs_imported');
    expect(result[0].has_real).toBe(true);
  });

  it('returns empty array when no imported groups', async () => {
    mockFetchSuccess([]);
    const result = await AdminDedupApiService.getImportedGroups();
    expect(result).toEqual([]);
  });

  it('throws when success=false', async () => {
    mockFetchError('Imported groups fetch failed');
    await expect(AdminDedupApiService.getImportedGroups()).rejects.toThrow(
      'Imported groups fetch failed',
    );
  });
});
