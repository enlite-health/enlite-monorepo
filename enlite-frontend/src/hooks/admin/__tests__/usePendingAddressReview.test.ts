import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePendingAddressReview } from '../usePendingAddressReview';

// ── Mock AdminVacancyAddressApiService ─────────────────────────────────────────

const mockList = vi.fn();
const mockResolve = vi.fn();

vi.mock('@infrastructure/http/AdminVacancyAddressApiService', () => ({
  AdminVacancyAddressApiService: {
    listPendingAddressReview: (...args: any[]) => mockList(...args),
    resolveAddressReview: (...args: any[]) => mockResolve(...args),
    listPatientAddresses: vi.fn().mockResolvedValue([]),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ITEM_1 = {
  id: 'vac-1',
  case_number: 10,
  vacancy_number: 1,
  title: 'CASO 10-1',
  status: 'PENDING_REVIEW',
  legacy_address_hint: 'Av. Corrientes 1234, CABA',
  patient_id: 'pat-10',
  patient_name: 'Juan Pérez',
  audit_match_type: 'NONE' as const,
  audit_confidence_score: null,
  audit_attempted_match: null,
};

const ITEM_2 = {
  id: 'vac-2',
  case_number: 11,
  vacancy_number: 1,
  title: 'CASO 11-1',
  status: 'PENDING_REVIEW',
  legacy_address_hint: null,
  patient_id: 'pat-11',
  patient_name: 'María López',
  audit_match_type: 'FUZZY' as const,
  audit_confidence_score: 0.6,
  audit_attempted_match: 'Belgrano 500',
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('usePendingAddressReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetch on mount', () => {
    it('calls listPendingAddressReview without filter on mount', async () => {
      mockList.mockResolvedValue({ data: [ITEM_1, ITEM_2], total: 2 });

      const { result } = renderHook(() => usePendingAddressReview());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(mockList).toHaveBeenCalledTimes(1);
      expect(mockList).toHaveBeenCalledWith(undefined);
      expect(result.current.items).toHaveLength(2);
      expect(result.current.items[0].id).toBe('vac-1');
    });

    it('sets loading=true while fetching', async () => {
      let resolvePromise!: (v: any) => void;
      mockList.mockReturnValue(
        new Promise(res => { resolvePromise = res; }),
      );

      const { result } = renderHook(() => usePendingAddressReview());
      expect(result.current.loading).toBe(true);

      await act(async () => {
        resolvePromise({ data: [], total: 0 });
      });
      expect(result.current.loading).toBe(false);
    });

    it('sets error when fetch fails', async () => {
      mockList.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => usePendingAddressReview());

      await waitFor(() => {
        expect(result.current.loading).toBe(false);
      });

      expect(result.current.error).toBe('Network error');
    });
  });

  describe('openReview / closeReview', () => {
    it('openReview sets activeItem', async () => {
      mockList.mockResolvedValue({ data: [ITEM_1], total: 1 });

      const { result } = renderHook(() => usePendingAddressReview());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => result.current.openReview(ITEM_1));
      expect(result.current.activeItem).toEqual(ITEM_1);
    });

    it('closeReview clears activeItem', async () => {
      mockList.mockResolvedValue({ data: [ITEM_1], total: 1 });

      const { result } = renderHook(() => usePendingAddressReview());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => result.current.openReview(ITEM_1));
      act(() => result.current.closeReview());
      expect(result.current.activeItem).toBeNull();
    });
  });

  describe('resolve', () => {
    it('removes resolved item from list and clears activeItem', async () => {
      mockList.mockResolvedValue({ data: [ITEM_1, ITEM_2], total: 2 });
      mockResolve.mockResolvedValue(undefined);

      const { result } = renderHook(() => usePendingAddressReview());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => result.current.openReview(ITEM_1));

      await act(async () => {
        await result.current.resolve({ patient_address_id: 'addr-1' });
      });

      expect(mockResolve).toHaveBeenCalledWith('vac-1', { patient_address_id: 'addr-1' });
      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0].id).toBe('vac-2');
      expect(result.current.activeItem).toBeNull();
    });

    it('resolve with createAddress calls API with correct body', async () => {
      mockList.mockResolvedValue({ data: [ITEM_2], total: 1 });
      mockResolve.mockResolvedValue(undefined);

      const { result } = renderHook(() => usePendingAddressReview());
      await waitFor(() => expect(result.current.loading).toBe(false));

      act(() => result.current.openReview(ITEM_2));

      const createBody = {
        createAddress: {
          address_formatted: 'Florida 100',
        },
      };

      await act(async () => {
        await result.current.resolve(createBody);
      });

      expect(mockResolve).toHaveBeenCalledWith('vac-2', createBody);
      expect(result.current.items).toHaveLength(0);
    });

    it('does nothing if activeItem is null', async () => {
      mockList.mockResolvedValue({ data: [], total: 0 });

      const { result } = renderHook(() => usePendingAddressReview());
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.resolve({ patient_address_id: 'addr-x' });
      });

      expect(mockResolve).not.toHaveBeenCalled();
    });
  });

  describe('fetchItems with filter', () => {
    it('passes statusFilter to API', async () => {
      mockList.mockResolvedValue({ data: [], total: 0 });

      const { result } = renderHook(() => usePendingAddressReview());
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.fetchItems('ACTIVE');
      });

      expect(mockList).toHaveBeenCalledWith('ACTIVE');
    });
  });
});
