import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePatientVacancies } from '../usePatientVacancies';
import { AdminPatientsApiService } from '@infrastructure/http/AdminPatientsApiService';
import type { PatientVacancySummary } from '@domain/entities/PatientDetail';

vi.mock('@infrastructure/http/AdminPatientsApiService');

const VACANCY_1: PatientVacancySummary = {
  id: 'v-1',
  caseNumber: 100,
  vacancyNumber: 1,
  title: 'Vaga 1',
  status: 'OPEN',
  isDraft: false,
  createdAt: '2026-01-01T00:00:00Z',
};

const VACANCY_2: PatientVacancySummary = {
  id: 'v-2',
  caseNumber: 100,
  vacancyNumber: 2,
  title: 'Vaga 2',
  status: 'OPEN',
  isDraft: false,
  createdAt: '2026-01-02T00:00:00Z',
};

describe('usePatientVacancies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isLoading=true no carregamento inicial', () => {
    vi.spyOn(AdminPatientsApiService, 'getPatientVacancies').mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => usePatientVacancies('p-1'));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.vacancies).toEqual([]);
  });

  // ── Item 1+4 (A1): mesmo padrão de usePatientDetail.refetch ────────────────
  // Causa: ServicosContratadosCard chama refetchVacancies() no onSaved; o hook antigo reexecutava
  // o efeito via refreshKey, que liga isLoading — PatientVacanciesCard troca a lista pelo estado
  // de loading a cada salvamento de serviço.

  it('🔴 refetch() NÃO liga isLoading — a lista de vagas não pisca', async () => {
    const spy = vi.spyOn(AdminPatientsApiService, 'getPatientVacancies')
      .mockResolvedValueOnce([VACANCY_1])
      .mockResolvedValueOnce([VACANCY_1, VACANCY_2]);

    const { result } = renderHook(() => usePatientVacancies('p-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.vacancies).toEqual([VACANCY_1]);

    act(() => {
      result.current.refetch();
    });

    // Sincronamente — nunca liga isLoading, e a lista ANTERIOR continua visível.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.vacancies).toEqual([VACANCY_1]);

    await waitFor(() => expect(result.current.vacancies).toEqual([VACANCY_1, VACANCY_2]));

    expect(result.current.isLoading).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetch() com erro mantém a lista anterior e expõe o erro', async () => {
    vi.spyOn(AdminPatientsApiService, 'getPatientVacancies')
      .mockResolvedValueOnce([VACANCY_1])
      .mockRejectedValueOnce(new Error('Error al cargar vacantes'));

    const { result } = renderHook(() => usePatientVacancies('p-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.error).toBe('Error al cargar vacantes'));

    expect(result.current.vacancies).toEqual([VACANCY_1]);
    expect(result.current.isLoading).toBe(false);
  });

  it('carregamento inicial: erro seta `error` (Error real) e mantém `vacancies` vazio', async () => {
    vi.spyOn(AdminPatientsApiService, 'getPatientVacancies').mockRejectedValue(new Error('Error al cargar vacantes'));

    const { result } = renderHook(() => usePatientVacancies('p-1'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Error al cargar vacantes');
    expect(result.current.vacancies).toEqual([]);
  });

  it('carregamento inicial: erro que NÃO é `Error` cai no fallback', async () => {
    vi.spyOn(AdminPatientsApiService, 'getPatientVacancies').mockRejectedValue('algo estranho');

    const { result } = renderHook(() => usePatientVacancies('p-1'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Error al cargar vacantes');
  });

  it('refetch() com erro que NÃO é `Error` cai no fallback (mantendo a lista anterior)', async () => {
    vi.spyOn(AdminPatientsApiService, 'getPatientVacancies')
      .mockResolvedValueOnce([VACANCY_1])
      .mockRejectedValueOnce('algo estranho');

    const { result } = renderHook(() => usePatientVacancies('p-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.error).toBe('Error al cargar vacantes'));
    expect(result.current.vacancies).toEqual([VACANCY_1]);
  });

  it('refetch() não faz nada sem patientId', () => {
    const spy = vi.spyOn(AdminPatientsApiService, 'getPatientVacancies');
    const { result } = renderHook(() => usePatientVacancies(undefined));

    act(() => {
      result.current.refetch();
    });

    expect(spy).not.toHaveBeenCalled();
  });
});
