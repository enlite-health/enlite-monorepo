import { describe, it, expect, vi as vitestVi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAnaCareHoursPatient } from './useAnaCareHoursPatient';
import { AnaCareHoursServiceError, FakeAnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { AnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { AnaCareMonthSnapshot } from '@presentation/components/features/admin/AnaCareHours/types';

const SNAPSHOT: AnaCareMonthSnapshot = {
  month: '2026-08',
  updatedAt: '2026-09-15T08:00:00-03:00',
  stale: false,
  circuitBreakerOpen: false,
  patients: [{ anaCareId: '90000', linked: true, name: 'Lucía Fernández QA', providers: [] }],
};

describe('useAnaCareHoursPatient', () => {
  it('POSITIVO — carrega paciente + retrato em paralelo e monta o snapshot "de 1 paciente"', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '2026-08', '90000'));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.patient?.anaCareId).toBe('90000');
    expect(result.current.snapshot?.patients).toEqual([result.current.patient]);
  });

  it('NEGATIVO — paciente inexistente: snapshot existe (retrato carregou) mas patients é []', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '2026-08', 'no-existe'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.patient).toBeNull();
    expect(result.current.snapshot?.patients).toEqual([]);
  });

  it('NEGATIVO — erro genérico vira mensagem em `error`', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vitestVi.fn(),
      getPatientMonth: vitestVi.fn().mockRejectedValue(new Error('falhou')),
      getRetratoStatus: vitestVi.fn().mockResolvedValue({ updatedAt: '', stale: false, circuitBreakerOpen: false }),
      validateShift: vitestVi.fn(),
      validateBatch: vitestVi.fn(),
      contestShift: vitestVi.fn(),
    };
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '2026-08', '90000'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('falhou');
  });

  it('NEGATIVO — erro FONTE_NAO_CONFIGURADA guarda o CÓDIGO', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vitestVi.fn(),
      getPatientMonth: vitestVi.fn().mockRejectedValue(new AnaCareHoursServiceError('FONTE_NAO_CONFIGURADA', 'x')),
      getRetratoStatus: vitestVi.fn().mockResolvedValue({ updatedAt: '', stale: false, circuitBreakerOpen: false }),
      validateShift: vitestVi.fn(),
      validateBatch: vitestVi.fn(),
      contestShift: vitestVi.fn(),
    };
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '2026-08', '90000'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('FONTE_NAO_CONFIGURADA');
  });

  it('NEGATIVO — rejeição sem Error (valor não-Error) cai no texto fixo padrão', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vitestVi.fn(),
      getPatientMonth: vitestVi.fn().mockRejectedValue('string-cru-sem-Error'),
      getRetratoStatus: vitestVi.fn().mockResolvedValue({ updatedAt: '', stale: false, circuitBreakerOpen: false }),
      validateShift: vitestVi.fn(),
      validateBatch: vitestVi.fn(),
      contestShift: vitestVi.fn(),
    };
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '2026-08', '90000'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('No se pudo cargar el paciente.');
  });

  it('POSITIVO — desmontar antes da resposta chegar não seta estado (guarda `cancelled`, sucesso e erro)', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    let rejectFn: (err: unknown) => void = () => {};
    const pendingOk = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const service: AnaCareHoursService = {
      getMonthSnapshot: vitestVi.fn(),
      getPatientMonth: vitestVi.fn().mockReturnValue(pendingOk),
      getRetratoStatus: vitestVi.fn().mockResolvedValue({ updatedAt: '', stale: false, circuitBreakerOpen: false }),
      validateShift: vitestVi.fn(),
      validateBatch: vitestVi.fn(),
      contestShift: vitestVi.fn(),
    };
    const { unmount } = renderHook(() => useAnaCareHoursPatient(service, '2026-08', '90000'));
    unmount();
    resolveFn(null);
    await pendingOk;

    const pendingErr = new Promise((_resolve, reject) => {
      rejectFn = reject;
    });
    const service2: AnaCareHoursService = {
      ...service,
      getPatientMonth: vitestVi.fn().mockReturnValue(pendingErr),
    };
    const { unmount: unmount2 } = renderHook(() => useAnaCareHoursPatient(service2, '2026-08', '90000'));
    unmount2();
    rejectFn(new Error('tarde demais'));
    await pendingErr.catch(() => {});
  });

  it('POSITIVO — refetch dispara nova busca', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    const spy = vitestVi.spyOn(service, 'getPatientMonth');
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '2026-08', '90000'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => result.current.refetch());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
