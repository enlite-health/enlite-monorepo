import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePatientDetail } from './usePatientDetail';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientDetail } from '@domain/entities/PatientDetail';

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getPatientById: vi.fn(),
  },
}));

function makePatient(overrides: Partial<PatientDetail> = {}): PatientDetail {
  return {
    id: 'p1',
    firstName: 'Paciente Base',
    ...overrides,
  } as unknown as PatientDetail;
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

describe('usePatientDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initial load: applies the fetched patient once resolved', async () => {
    const mock = vi.mocked(AdminApiService.getPatientById);
    mock.mockResolvedValueOnce(makePatient({ firstName: 'Paciente Inicial' }));

    const { result } = renderHook(() => usePatientDetail('p1'));

    await waitFor(() => expect(result.current.patient?.firstName).toBe('Paciente Inicial'));
  });

  it('refetch: two requests, first resolves AFTER the second — final state is the second (latest)', async () => {
    const mock = vi.mocked(AdminApiService.getPatientById);
    const first = deferred<PatientDetail>();
    const second = deferred<PatientDetail>();

    // Carga inicial resolvida de imediato.
    mock.mockResolvedValueOnce(makePatient({ firstName: 'Inicial' }));
    const { result } = renderHook(() => usePatientDetail('p1'));
    await waitFor(() => expect(result.current.patient?.firstName).toBe('Inicial'));

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
      second.resolve(makePatient({ firstName: 'Segunda' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.patient?.firstName).toBe('Segunda'));

    // A PRIMEIRA requisição (mais antiga) resolve depois — não pode sobrescrever.
    await act(async () => {
      first.resolve(makePatient({ firstName: 'Primeira' }));
      await Promise.resolve();
    });

    expect(result.current.patient?.firstName).toBe('Segunda');
  });

  it('refetch: stale response after patientId changed does not overwrite the new patient state', async () => {
    const mock = vi.mocked(AdminApiService.getPatientById);
    const staleP1 = deferred<PatientDetail>();

    mock.mockResolvedValueOnce(makePatient({ id: 'p1', firstName: 'Paciente 1' }));
    const { result, rerender } = renderHook(
      ({ patientId }: { patientId: string }) => usePatientDetail(patientId),
      { initialProps: { patientId: 'p1' } },
    );
    await waitFor(() => expect(result.current.patient?.firstName).toBe('Paciente 1'));

    // Dispara um refetch para p1 que fica pendente (não resolve ainda).
    mock.mockReturnValueOnce(staleP1.promise);
    act(() => {
      result.current.refetch();
    });

    // Troca de paciente: o efeito de carga inicial busca p2 e resolve.
    mock.mockResolvedValueOnce(makePatient({ id: 'p2', firstName: 'Paciente 2' }));
    rerender({ patientId: 'p2' });
    await waitFor(() => expect(result.current.patient?.id).toBe('p2'));

    // A resposta atrasada do refetch de p1 chega agora — não pode sobrescrever p2.
    await act(async () => {
      staleP1.resolve(makePatient({ id: 'p1', firstName: 'Paciente 1 atrasado' }));
      await Promise.resolve();
    });

    expect(result.current.patient?.id).toBe('p2');
    expect(result.current.patient?.firstName).toBe('Paciente 2');
  });

  it('initial load: sets error when the fetch rejects', async () => {
    const mock = vi.mocked(AdminApiService.getPatientById);
    mock.mockRejectedValueOnce(new Error('Falha de rede'));

    const { result } = renderHook(() => usePatientDetail('p1'));

    await waitFor(() => expect(result.current.error).toBe('Falha de rede'));
    expect(result.current.isLoading).toBe(false);
  });

  it('refetch: sets error when the (latest) refetch rejects', async () => {
    const mock = vi.mocked(AdminApiService.getPatientById);
    mock.mockResolvedValueOnce(makePatient({ firstName: 'Inicial' }));
    const { result } = renderHook(() => usePatientDetail('p1'));
    await waitFor(() => expect(result.current.patient?.firstName).toBe('Inicial'));

    mock.mockRejectedValueOnce(new Error('Erro no refetch'));
    await act(async () => {
      result.current.refetch();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.error).toBe('Erro no refetch'));
    // Falha no refetch silencioso NÃO apaga os dados anteriores.
    expect(result.current.patient?.firstName).toBe('Inicial');
  });

  it('refetch: a stale (superseded) rejection does not set error over the latest state', async () => {
    const mock = vi.mocked(AdminApiService.getPatientById);
    const stale = deferred<PatientDetail>();
    const latest = deferred<PatientDetail>();

    mock.mockResolvedValueOnce(makePatient({ firstName: 'Inicial' }));
    const { result } = renderHook(() => usePatientDetail('p1'));
    await waitFor(() => expect(result.current.patient?.firstName).toBe('Inicial'));

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
      latest.resolve(makePatient({ firstName: 'Mais recente' }));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.patient?.firstName).toBe('Mais recente'));

    // A antiga (stale) rejeita depois — não pode setar `error` por cima do estado atual.
    await act(async () => {
      stale.reject(new Error('Erro da requisição antiga'));
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.patient?.firstName).toBe('Mais recente');
  });

  it('patientId undefined: does not fetch and refetch is a no-op', async () => {
    const mock = vi.mocked(AdminApiService.getPatientById);

    const { result } = renderHook(() => usePatientDetail(undefined));
    act(() => {
      result.current.refetch();
    });

    expect(mock).not.toHaveBeenCalled();
    expect(result.current.patient).toBeNull();
  });

  it('initial load: falls back to the default message when the error has none', async () => {
    const mock = vi.mocked(AdminApiService.getPatientById);
    mock.mockRejectedValueOnce({});

    const { result } = renderHook(() => usePatientDetail('p1'));

    await waitFor(() => expect(result.current.error).toBe('Falha ao carregar paciente'));
  });

  it('refetch: falls back to the default message when the error has none', async () => {
    const mock = vi.mocked(AdminApiService.getPatientById);
    mock.mockResolvedValueOnce(makePatient({ firstName: 'Inicial' }));
    const { result } = renderHook(() => usePatientDetail('p1'));
    await waitFor(() => expect(result.current.patient?.firstName).toBe('Inicial'));

    mock.mockRejectedValueOnce({});
    await act(async () => {
      result.current.refetch();
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.error).toBe('Falha ao carregar paciente'));
  });
});
