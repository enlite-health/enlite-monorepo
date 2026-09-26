import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useInvitedPendingCandidates } from './useInvitedPendingCandidates';
import * as funnelTableHook from './useVacancyFunnelTable';
import type { FunnelTableData } from '@domain/entities/Funnel';

vi.mock('./useVacancyFunnelTable');

const VACANCY_ID = 'test-vacancy-id';

function makeRow(
  workerId: string,
  workerName: string,
  whatsappStatus: 'NOT_SENT' | 'SENT' | 'DELIVERED' | 'READ' | 'REPLIED' | 'FAILED',
  whatsappLastDispatchedAt: string | null = null,
) {
  return {
    id: `row-${workerId}`,
    workerId,
    workerName,
    workerEmail: null,
    workerPhone: null,
    workerAvatarUrl: null,
    invitedAt: '2026-04-01T10:00:00Z',
    funnelStage: 'INVITED',
    whatsappStatus,
    whatsappLastDispatchedAt,
    accepted: null,
    interviewResponse: null,
    registrationComplete: false,
    contactNotesCount: 0,
    kanbanColumn: null,
    isBlocked: false,
  };
}

function mockFunnelTable(data: FunnelTableData | null, isLoading = false) {
  vi.spyOn(funnelTableHook, 'useVacancyFunnelTable').mockReturnValue({
    data,
    isLoading,
    error: null,
    refetch: vi.fn(),
  });
}

describe('useInvitedPendingCandidates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 3 candidates when 3 rows have NOT_SENT status', () => {
    const rows = [
      makeRow('w1', 'Ana García', 'NOT_SENT'),
      makeRow('w2', 'Bruno López', 'NOT_SENT'),
      makeRow('w3', 'Carla Méndez', 'NOT_SENT'),
    ];
    mockFunnelTable({
      rows,
      counts: {
        INVITED: 3,
        POSTULATED: 0,
        PRE_SELECTED: 0,
        REJECTED: 0,
        WITHDREW: 0,
        ALL: 3,
        columns: {},
      },
    });

    const { result } = renderHook(() =>
      useInvitedPendingCandidates(VACANCY_ID),
    );

    expect(result.current.pendingCount).toBe(3);
    expect(result.current.candidates).toHaveLength(3);
    expect(result.current.candidates[0].workerId).toBe('w1');
    expect(result.current.candidates[0].workerName).toBe('Ana García');
  });

  it('returns empty when all rows have SENT status', () => {
    const rows = [
      makeRow('w1', 'Ana García', 'SENT', '2026-04-01T10:01:00Z'),
      makeRow('w2', 'Bruno López', 'DELIVERED', '2026-04-01T10:02:00Z'),
      makeRow('w3', 'Carla Méndez', 'READ', '2026-04-01T10:03:00Z'),
    ];
    mockFunnelTable({
      rows,
      counts: {
        INVITED: 3,
        POSTULATED: 0,
        PRE_SELECTED: 0,
        REJECTED: 0,
        WITHDREW: 0,
        ALL: 3,
        columns: {},
      },
    });

    const { result } = renderHook(() =>
      useInvitedPendingCandidates(VACANCY_ID),
    );

    expect(result.current.pendingCount).toBe(0);
    expect(result.current.candidates).toHaveLength(0);
  });

  it('returns empty when data is undefined (loading state)', () => {
    mockFunnelTable(null, true);

    const { result } = renderHook(() =>
      useInvitedPendingCandidates(VACANCY_ID),
    );

    expect(result.current.pendingCount).toBe(0);
    expect(result.current.candidates).toHaveLength(0);
    expect(result.current.isLoading).toBe(true);
  });
});
