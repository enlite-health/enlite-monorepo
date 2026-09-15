import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePatientVacancies } from './usePatientVacancies';
import { AdminPatientsApiService } from '@infrastructure/http/AdminPatientsApiService';
import type { PatientVacancySummary } from '@domain/entities/PatientDetail';

vi.mock('@infrastructure/http/AdminPatientsApiService', () => ({
  AdminPatientsApiService: {
    getPatientVacancies: vi.fn(),
  },
}));

function makeVacancies(title: string): PatientVacancySummary[] {
  return [
    {
      id: `v-${title}`,
      caseNumber: 1,
      vacancyNumber: 1,
      title,
      status: 'OPEN',
      isDraft: false,
      createdAt: '2026-09-01T00:00:00Z',
    },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('usePatientVacancies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initial load: applies the fetched vacancies once resolved', async () => {
    const mock = vi.mocked(AdminPatientsApiService.getPatientVacancies);
    mock.mockResolvedValueOnce(makeVacancies('Inicial'));

    const { result } = renderHook(() => usePatientVacancies('p1'));

    await waitFor(() => expect(result.current.vacancies[0]?.title).toBe('Inicial'));
  });

  it('refetch: two requests, first resolves AFTER the second — final state is the second (latest)', async () => {
    const mock = vi.mocked(AdminPatientsApiService.getPatientVacancies);
    const first = deferred<PatientVacancySummary[]>();
    const second = deferred<PatientVacancySummary[]>();

    mock.mockResolvedValueOnce(makeVacancies('Inicial'));
    const { result } = renderHook(() => usePatientVacancies('p1'));
    await waitFor(() => expect(result.current.vacancies[0]?.title).toBe('Inicial'));

    mock.mockReturnValueOnce(first.promise);
    act(() => {
      result.current.refetch();
    });

    mock.mockReturnValueOnce(second.promise);
    act(() => {
      result.current.refetch();
    });

    // A SEGUNDA requisição (mais recente) resolve primeiro.
    await act(async () => {
      second.resolve(makeVacancies('Segunda'));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.vacancies[0]?.title).toBe('Segunda'));

    // A PRIMEIRA requisição (mais antiga) resolve depois — não pode sobrescrever.
    await act(async () => {
      first.resolve(makeVacancies('Primeira'));
      await Promise.resolve();
    });

    expect(result.current.vacancies[0]?.title).toBe('Segunda');
  });

  it('refetch: stale response after patientId changed does not overwrite the new patient state', async () => {
    const mock = vi.mocked(AdminPatientsApiService.getPatientVacancies);
    const staleP1 = deferred<PatientVacancySummary[]>();

    mock.mockResolvedValueOnce(makeVacancies('Paciente 1'));
    const { result, rerender } = renderHook(
      ({ patientId }: { patientId: string }) => usePatientVacancies(patientId),
      { initialProps: { patientId: 'p1' } },
    );
    await waitFor(() => expect(result.current.vacancies[0]?.title).toBe('Paciente 1'));

    // Dispara um refetch para p1 que fica pendente (não resolve ainda).
    mock.mockReturnValueOnce(staleP1.promise);
    act(() => {
      result.current.refetch();
    });

    // Troca de paciente: o efeito de carga inicial busca p2 e resolve.
    mock.mockResolvedValueOnce(makeVacancies('Paciente 2'));
    rerender({ patientId: 'p2' });
    await waitFor(() => expect(result.current.vacancies[0]?.title).toBe('Paciente 2'));

    // A resposta atrasada do refetch de p1 chega agora — não pode sobrescrever p2.
    await act(async () => {
      staleP1.resolve(makeVacancies('Paciente 1 atrasado'));
      await Promise.resolve();
    });

    expect(result.current.vacancies[0]?.title).toBe('Paciente 2');
  });

  it('initial load: sets error when the fetch rejects', async () => {
    const mock = vi.mocked(AdminPatientsApiService.getPatientVacancies);
    mock.mockRejectedValueOnce(new Error('Falha de rede'));

    const { result } = renderHook(() => usePatientVacancies('p1'));

    await waitFor(() => expect(result.current.error).toBe('Falha de rede'));
    expect(result.current.isLoading).toBe(false);
  });

  it('refetch: sets error when the (latest) refetch rejects', async () => {
    const mock = vi.mocked(AdminPatientsApiService.getPatientVacancies);
    mock.mockResolvedValueOnce(makeVacancies('Inicial'));
    const { result } = renderHook(() => usePatientVacancies('p1'));
    await waitFor(() => expect(result.current.vacancies[0]?.title).toBe('Inicial'));

    mock.mockRejectedValueOnce(new Error('Erro no refetch'));
    await act(async () => {
      result.current.refetch();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.error).toBe('Erro no refetch'));
    // Falha no refetch silencioso NÃO apaga a lista anterior.
    expect(result.current.vacancies[0]?.title).toBe('Inicial');
  });

  it('refetch: a stale (superseded) rejection does not set error over the latest state', async () => {
    const mock = vi.mocked(AdminPatientsApiService.getPatientVacancies);
    const stale = deferred<PatientVacancySummary[]>();
    const latest = deferred<PatientVacancySummary[]>();

    mock.mockResolvedValueOnce(makeVacancies('Inicial'));
    const { result } = renderHook(() => usePatientVacancies('p1'));
    await waitFor(() => expect(result.current.vacancies[0]?.title).toBe('Inicial'));

    mock.mockReturnValueOnce(stale.promise);
    act(() => {
      result.current.refetch();
    });

    mock.mockReturnValueOnce(latest.promise);
    act(() => {
      result.current.refetch();
    });

    // A mais recente resolve com sucesso.
    await act(async () => {
      latest.resolve(makeVacancies('Mais recente'));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.vacancies[0]?.title).toBe('Mais recente'));

    // A antiga (stale) rejeita depois — não pode setar `error` por cima do estado atual.
    await act(async () => {
      stale.reject(new Error('Erro da requisição antiga'));
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.vacancies[0]?.title).toBe('Mais recente');
  });

  it('patientId undefined: does not fetch and refetch is a no-op', async () => {
    const mock = vi.mocked(AdminPatientsApiService.getPatientVacancies);

    const { result } = renderHook(() => usePatientVacancies(undefined));
    act(() => {
      result.current.refetch();
    });

    expect(mock).not.toHaveBeenCalled();
    expect(result.current.vacancies).toHaveLength(0);
  });

  it('initial load: falls back to the default message when the rejection is not an Error', async () => {
    const mock = vi.mocked(AdminPatientsApiService.getPatientVacancies);
    mock.mockRejectedValueOnce('boom');

    const { result } = renderHook(() => usePatientVacancies('p1'));

    await waitFor(() => expect(result.current.error).toBe('Error al cargar vacantes'));
  });

  it('refetch: falls back to the default message when the rejection is not an Error', async () => {
    const mock = vi.mocked(AdminPatientsApiService.getPatientVacancies);
    mock.mockResolvedValueOnce(makeVacancies('Inicial'));
    const { result } = renderHook(() => usePatientVacancies('p1'));
    await waitFor(() => expect(result.current.vacancies[0]?.title).toBe('Inicial'));

    mock.mockRejectedValueOnce('boom');
    await act(async () => {
      result.current.refetch();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.error).toBe('Error al cargar vacantes'));
  });
});
