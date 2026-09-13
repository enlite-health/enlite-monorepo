import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AdminVacancyAddressApiService } from '../AdminVacancyAddressApiService';

// ── Mock FirebaseAuthService ───────────────────────────────────────────────────

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    json: async () => body,
  });
}

function capturedUrl(): string {
  return (global.fetch as Mock).mock.calls[0][0] as string;
}

function capturedOptions(): RequestInit {
  return (global.fetch as Mock).mock.calls[0][1] as RequestInit;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PENDING_ITEM = {
  id: 'vac-1',
  case_number: 5,
  vacancy_number: 1,
  title: 'CASO 5-1',
  status: 'PENDING_REVIEW',
  legacy_address_hint: 'Corrientes 1234',
  patient_id: 'pat-5',
  patient_name: 'Ana García',
  audit_match_type: 'NONE',
  audit_confidence_score: null,
  audit_attempted_match: null,
};

const ADDRESS_ROW = {
  id: 'addr-1',
  patient_id: 'pat-5',
  address_formatted: 'Corrientes 1234, CABA',
  address_raw: 'Corrientes 1234',
  display_order: 0,
  source: 'manual',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('AdminVacancyAddressApiService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listPendingAddressReview', () => {
    it('calls GET /api/admin/vacancies/pending-address-review without filter', async () => {
      mockFetch({ success: true, data: [PENDING_ITEM], total: 1 });

      const result = await AdminVacancyAddressApiService.listPendingAddressReview();

      expect(capturedUrl()).toContain('/api/admin/vacancies/pending-address-review');
      expect(capturedUrl()).not.toContain('status=');
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('appends status query param when filter is provided', async () => {
      mockFetch({ success: true, data: [], total: 0 });

      await AdminVacancyAddressApiService.listPendingAddressReview('ACTIVE');

      expect(capturedUrl()).toContain('status=ACTIVE');
    });

    it('uses total from response', async () => {
      mockFetch({ success: true, data: [PENDING_ITEM], total: 42 });

      const result = await AdminVacancyAddressApiService.listPendingAddressReview();
      expect(result.total).toBe(42);
    });

    it('falls back to data.length when total is absent', async () => {
      mockFetch({ success: true, data: [PENDING_ITEM] });

      const result = await AdminVacancyAddressApiService.listPendingAddressReview();
      expect(result.total).toBe(1);
    });

    it('throws on error response', async () => {
      mockFetch({ success: false, error: 'Unauthorized' });

      await expect(AdminVacancyAddressApiService.listPendingAddressReview()).rejects.toThrow(
        'Unauthorized',
      );
    });
  });

  describe('resolveAddressReview', () => {
    it('calls POST /api/admin/vacancies/:id/resolve-address-review with patient_address_id', async () => {
      mockFetch({ success: true, data: null });

      await AdminVacancyAddressApiService.resolveAddressReview('vac-1', {
        patient_address_id: 'addr-1',
      });

      expect(capturedUrl()).toContain('/api/admin/vacancies/vac-1/resolve-address-review');
      expect(capturedOptions().method).toBe('POST');

      const sentBody = JSON.parse(capturedOptions().body as string);
      expect(sentBody).toEqual({ patient_address_id: 'addr-1' });
    });

    it('calls POST with createAddress body', async () => {
      mockFetch({ success: true, data: null });

      const createBody = {
        createAddress: {
          address_formatted: 'Florida 100',
          address_raw: 'Florida 100',
          address_type: 'service',
        },
      };

      await AdminVacancyAddressApiService.resolveAddressReview('vac-2', createBody);

      const sentBody = JSON.parse(capturedOptions().body as string);
      expect(sentBody).toEqual(createBody);
      expect(capturedUrl()).toContain('vac-2/resolve-address-review');
    });

    it('throws on error response', async () => {
      mockFetch({ success: false, error: 'Vacancy not found' });

      await expect(
        AdminVacancyAddressApiService.resolveAddressReview('vac-x', {
          patient_address_id: 'addr-1',
        }),
      ).rejects.toThrow('Vacancy not found');
    });
  });

  describe('listPatientAddresses', () => {
    it('calls GET /api/admin/patients/:patientId/addresses', async () => {
      mockFetch({ success: true, data: [ADDRESS_ROW] });

      const result = await AdminVacancyAddressApiService.listPatientAddresses('pat-5');

      expect(capturedUrl()).toContain('/api/admin/patients/pat-5/addresses');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('addr-1');
    });

    it('returns empty array when no addresses', async () => {
      mockFetch({ success: true, data: [] });

      const result = await AdminVacancyAddressApiService.listPatientAddresses('pat-5');
      expect(result).toEqual([]);
    });

    it('throws on error response', async () => {
      mockFetch({ success: false, error: 'Patient not found' });

      await expect(
        AdminVacancyAddressApiService.listPatientAddresses('pat-x'),
      ).rejects.toThrow('Patient not found');
    });
  });
});
