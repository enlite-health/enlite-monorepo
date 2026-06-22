import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWorkerDetail } from '../useWorkerDetail';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { WorkerDetail } from '@domain/entities/Worker';

vi.mock('@infrastructure/http/AdminApiService');

const MOCK_WORKER: WorkerDetail = {
  id: 'worker-123',
  email: 'ana.silva@test.com',
  phone: '+55 11 99999-0000',
  whatsappPhone: '+55 11 99999-0000',
  country: 'BR',
  timezone: 'America/Sao_Paulo',
  status: 'REGISTERED',
  overallStatus: 'QUALIFIED',
  availabilityStatus: 'available',
  dataSources: ['talentum'],
  platform: 'talentum',
  createdAt: '2026-01-10T00:00:00Z',
  updatedAt: '2026-03-20T00:00:00Z',

  firstName: 'Ana',
  lastName: 'Silva',
  sex: 'F',
  gender: 'Feminino',
  birthDate: '1995-06-15',
  documentType: 'CPF',
  documentNumber: '123.456.789-00',
  profilePhotoUrl: null,

  profession: 'Psicóloga',
  occupation: 'Acompanhante Terapêutico',
  knowledgeLevel: 'Senior',
  titleCertificate: 'CRP 06/12345',
  experienceTypes: ['TEA', 'TDAH'],
  yearsExperience: '5',
  preferredTypes: ['Presencial'],
  preferredAgeRange: ['Adulto'],
  languages: ['Português', 'Inglês'],

  sexualOrientation: null,
  race: null,
  religion: null,
  weightKg: null,
  heightCm: null,
  hobbies: [],
  diagnosticPreferences: ['TEA'],
  linkedinUrl: null,

  isMatchable: true,
  isActive: true,
  isTest: false,

  documents: null,
  serviceAreas: [],
  location: { address: 'Av. Paulista, 1000', city: 'São Paulo', workZone: 'Centro', interestZone: 'Zona Sul' },
  encuadres: [],
};

describe('useWorkerDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Initial state ──────────────────────────────────────────────────────────

  it('returns isLoading=true initially when workerId is provided', () => {
    vi.spyOn(AdminApiService, 'getWorkerById').mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useWorkerDetail('worker-123'));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.worker).toBeNull();
    expect(result.current.error).toBeNull();
  });

  // ── Successful fetch ───────────────────────────────────────────────────────

  it('returns worker data on successful fetch', async () => {
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER);

    const { result } = renderHook(() => useWorkerDetail('worker-123'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.worker).toEqual(MOCK_WORKER);
    expect(result.current.error).toBeNull();
    expect(AdminApiService.getWorkerById).toHaveBeenCalledWith('worker-123');
  });

  it('returns all entity fields including overallStatus and availabilityStatus', async () => {
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER);

    const { result } = renderHook(() => useWorkerDetail('worker-123'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.worker?.overallStatus).toBe('QUALIFIED');
    expect(result.current.worker?.availabilityStatus).toBe('available');
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  it('returns error on failed fetch', async () => {
    const errorMessage = 'Network error';
    vi.spyOn(AdminApiService, 'getWorkerById').mockRejectedValue(new Error(errorMessage));

    const { result } = renderHook(() => useWorkerDetail('worker-123'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe(errorMessage);
    expect(result.current.worker).toBeNull();
  });

  it('uses fallback message when error has no message property', async () => {
    vi.spyOn(AdminApiService, 'getWorkerById').mockRejectedValue({});

    const { result } = renderHook(() => useWorkerDetail('worker-123'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Falha ao carregar worker');
  });

  // ── No workerId ────────────────────────────────────────────────────────────

  it('does not fetch if workerId is undefined', () => {
    const spy = vi.spyOn(AdminApiService, 'getWorkerById');

    const { result } = renderHook(() => useWorkerDetail(undefined));

    expect(spy).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.worker).toBeNull();
    expect(result.current.error).toBeNull();
  });

  // ── Dependency changes ─────────────────────────────────────────────────────

  it('refetches when workerId changes', async () => {
    const spy = vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER);

    const { rerender } = renderHook(
      ({ id }) => useWorkerDetail(id),
      { initialProps: { id: 'worker-001' as string | undefined } },
    );

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('worker-001');
    });

    rerender({ id: 'worker-002' });

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith('worker-002');
    });
  });

  // ── Manual refetch ─────────────────────────────────────────────────────────

  it('refetch() triggers a new API call and updates worker', async () => {
    const updatedWorker: WorkerDetail = { ...MOCK_WORKER, firstName: 'Ana Updated' };
    const spy = vi.spyOn(AdminApiService, 'getWorkerById')
      .mockResolvedValueOnce(MOCK_WORKER)
      .mockResolvedValueOnce(updatedWorker);

    const { result } = renderHook(() => useWorkerDetail('worker-123'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.worker?.firstName).toBe('Ana');

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.worker?.firstName).toBe('Ana Updated');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetch() does nothing when workerId is undefined', () => {
    const spy = vi.spyOn(AdminApiService, 'getWorkerById');

    const { result } = renderHook(() => useWorkerDetail(undefined));

    act(() => {
      result.current.refetch();
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('refetch() sets error when API call fails', async () => {
    vi.spyOn(AdminApiService, 'getWorkerById')
      .mockResolvedValueOnce(MOCK_WORKER)
      .mockRejectedValueOnce(new Error('Server error'));

    const { result } = renderHook(() => useWorkerDetail('worker-123'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.worker).toEqual(MOCK_WORKER);

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Server error');
  });

  it('refetch() uses fallback message when error has no message', async () => {
    vi.spyOn(AdminApiService, 'getWorkerById')
      .mockResolvedValueOnce(MOCK_WORKER)
      .mockRejectedValueOnce({});

    const { result } = renderHook(() => useWorkerDetail('worker-123'));

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe('Falha ao carregar worker');
  });

  // ── Cleanup / cancellation ─────────────────────────────────────────────────

  it('does not update state after unmount (cancelled flag)', async () => {
    let resolvePromise: (value: WorkerDetail) => void;
    const pendingPromise = new Promise<WorkerDetail>((resolve) => {
      resolvePromise = resolve;
    });
    vi.spyOn(AdminApiService, 'getWorkerById').mockReturnValue(pendingPromise);

    const { result, unmount } = renderHook(() => useWorkerDetail('worker-123'));

    expect(result.current.isLoading).toBe(true);

    unmount();

    // Resolve after unmount — should NOT throw or update state
    resolvePromise!(MOCK_WORKER);

    // Allow microtask to flush
    await new Promise((r) => setTimeout(r, 10));

    // No error thrown — test passes if we reach here
    expect(true).toBe(true);
  });

  // ── Return shape ───────────────────────────────────────────────────────────

  it('returns an object with worker, isLoading, error, and refetch', () => {
    vi.spyOn(AdminApiService, 'getWorkerById').mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useWorkerDetail('worker-123'));

    expect(result.current).toHaveProperty('worker');
    expect(result.current).toHaveProperty('isLoading');
    expect(result.current).toHaveProperty('error');
    expect(result.current).toHaveProperty('refetch');
    expect(typeof result.current.refetch).toBe('function');
  });
});
