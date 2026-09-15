import { describe, it, expect, vi as vitestVi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAnaCareHoursMonth } from './useAnaCareHoursMonth';
import { AnaCareHoursServiceError, FakeAnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { AnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';

describe('useAnaCareHoursMonth', () => {
  it('POSITIVO — carrega o snapshot do mês', async () => {
    const service = new FakeAnaCareHoursService({});
    const { result } = renderHook(() => useAnaCareHoursMonth(service, '2026-08'));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.snapshot?.month).toBe('2026-08');
    expect(result.current.error).toBeNull();
  });

  it('NEGATIVO — erro genérico vira mensagem em `error`', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vitestVi.fn().mockRejectedValue(new Error('falhou')),
      getPatientMonth: vitestVi.fn(),
      getRetratoStatus: vitestVi.fn(),
      validateShift: vitestVi.fn(),
      validateBatch: vitestVi.fn(),
      contestShift: vitestVi.fn(),
    };
    const { result } = renderHook(() => useAnaCareHoursMonth(service, '2026-08'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('falhou');
  });

  it('NEGATIVO — erro FONTE_NAO_CONFIGURADA guarda o CÓDIGO em `error` (contrato 503)', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vitestVi.fn().mockRejectedValue(new AnaCareHoursServiceError('FONTE_NAO_CONFIGURADA', 'ANACARE_SOURCE_NOT_CONFIGURED')),
      getPatientMonth: vitestVi.fn(),
      getRetratoStatus: vitestVi.fn(),
      validateShift: vitestVi.fn(),
      validateBatch: vitestVi.fn(),
      contestShift: vitestVi.fn(),
    };
    const { result } = renderHook(() => useAnaCareHoursMonth(service, '2026-08'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('FONTE_NAO_CONFIGURADA');
  });

  it('POSITIVO — refetch dispara nova busca', async () => {
    const service = new FakeAnaCareHoursService({});
    const spy = vitestVi.spyOn(service, 'getMonthSnapshot');
    const { result } = renderHook(() => useAnaCareHoursMonth(service, '2026-08'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => result.current.refetch());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('NEGATIVO — rejeição sem Error (valor não-Error) cai no texto fixo padrão', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vitestVi.fn().mockRejectedValue('string-cru-sem-Error'),
      getPatientMonth: vitestVi.fn(),
      getRetratoStatus: vitestVi.fn(),
      validateShift: vitestVi.fn(),
      validateBatch: vitestVi.fn(),
      contestShift: vitestVi.fn(),
    };
    const { result } = renderHook(() => useAnaCareHoursMonth(service, '2026-08'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('No se pudo cargar el mes.');
  });

  it('POSITIVO — desmontar antes da resposta chegar não seta estado (guarda `cancelled`)', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveFn = resolve;
    });
    const service: AnaCareHoursService = {
      getMonthSnapshot: vitestVi.fn().mockReturnValue(pending),
      getPatientMonth: vitestVi.fn(),
      getRetratoStatus: vitestVi.fn(),
      validateShift: vitestVi.fn(),
      validateBatch: vitestVi.fn(),
      contestShift: vitestVi.fn(),
    };
    const { unmount } = renderHook(() => useAnaCareHoursMonth(service, '2026-08'));
    unmount();
    resolveFn({ month: '2026-08', updatedAt: '', stale: false, circuitBreakerOpen: false, patients: [] });
    await Promise.resolve();
    // Sem asserção de estado (o componente já desmontou) — o teste prova que resolver DEPOIS do
    // unmount não lança "state update on unmounted component" nem quebra.
  });

  it('POSITIVO — desmontar antes de um ERRO chegar não seta estado (guarda `cancelled` no catch)', async () => {
    let rejectFn: (err: unknown) => void = () => {};
    const pending = new Promise((_resolve, reject) => {
      rejectFn = reject;
    });
    const service: AnaCareHoursService = {
      getMonthSnapshot: vitestVi.fn().mockReturnValue(pending),
      getPatientMonth: vitestVi.fn(),
      getRetratoStatus: vitestVi.fn(),
      validateShift: vitestVi.fn(),
      validateBatch: vitestVi.fn(),
      contestShift: vitestVi.fn(),
    };
    const { unmount } = renderHook(() => useAnaCareHoursMonth(service, '2026-08'));
    unmount();
    rejectFn(new Error('tarde demais'));
    await pending.catch(() => {});
  });

  it('POSITIVO — troca de mês refaz a busca', async () => {
    const service = new FakeAnaCareHoursService({});
    const { result, rerender } = renderHook(({ month }) => useAnaCareHoursMonth(service, month), { initialProps: { month: '2026-08' } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ month: '2026-09' });
    await waitFor(() => expect(result.current.snapshot?.month).toBe('2026-09'));
  });

  it('POSITIVO — filtros (patientSearch/providerId) são repassados ao serviço', async () => {
    const service = new FakeAnaCareHoursService({});
    const spy = vitestVi.spyOn(service, 'getMonthSnapshot');
    const { result } = renderHook(() => useAnaCareHoursMonth(service, '2026-08', { patientSearch: 'Lucía', providerId: 'p1' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(spy).toHaveBeenCalledWith('2026-08', { patientSearch: 'Lucía', providerId: 'p1' });
  });
});
