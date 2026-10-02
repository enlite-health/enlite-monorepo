import { describe, it, expect, vi as vitestVi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAnaCareHoursPatient } from './useAnaCareHoursPatient';
import { AnaCareHoursServiceError, FakeAnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { AnaCareHoursService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursService';
import type { AnaCareHoursPatientSnapshot, AnaCarePatient, AnaCareShift } from '@presentation/components/features/admin/AnaCareHours/types';

const SNAPSHOT: AnaCareHoursPatientSnapshot = {
  month: '2026-08',
  updatedAt: '2026-09-15T08:00:00-03:00',
  stale: false,
  snapshotState: 'fresco',
  circuitBreakerOpen: false,
  patients: [{ anaCareId: '90000', linked: true, name: 'Lucía Fernández QA', providers: [] }],
};

describe('useAnaCareHoursPatient', () => {
  it('POSITIVO — carrega paciente + retrato em paralelo e monta o snapshot "de 1 paciente"', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-08'], '2026-08'));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.patient?.anaCareId).toBe('90000');
    expect(result.current.snapshot?.patients).toEqual([result.current.patient]);
  });

  /**
   * Item 3 (conserto, 17/09): antes, o hook aproximava `snapshotState` por `stale ? 'velho' :
   * 'fresco'` — colapsando "nunca construído" em "velho". Agora `AnaCareRetratoStatus` carrega
   * `snapshotState` de verdade, e o hook só repassa. Este teste MORRE se a aproximação voltar.
   */
  it('POSITIVO — propaga snapshotState "nao_construido" do retrato sem aproximar por `stale`', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vitestVi.fn(),
      getPatientMonth: vitestVi.fn().mockResolvedValue(SNAPSHOT.patients[0]),
      getRetratoStatus: vitestVi.fn().mockResolvedValue({ updatedAt: '', stale: true, snapshotState: 'nao_construido', circuitBreakerOpen: false }),
      validateShift: vitestVi.fn(),
      validateBatch: vitestVi.fn(),
      contestShift: vitestVi.fn(),
    };
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-08'], '2026-08'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.snapshot?.snapshotState).toBe('nao_construido');
  });

  it('NEGATIVO — paciente inexistente: snapshot existe (retrato carregou) mas patients é []', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    const { result } = renderHook(() => useAnaCareHoursPatient(service, 'no-existe', ['2026-08'], '2026-08'));
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
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-08'], '2026-08'));
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
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-08'], '2026-08'));
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
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-08'], '2026-08'));
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
    const { unmount } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-08'], '2026-08'));
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
    const { unmount: unmount2 } = renderHook(() => useAnaCareHoursPatient(service2, '90000', ['2026-08'], '2026-08'));
    unmount2();
    rejectFn(new Error('tarde demais'));
    await pendingErr.catch(() => {});
  });

  it('POSITIVO — refetch dispara nova busca', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    const spy = vitestVi.spyOn(service, 'getPatientMonth');
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-08'], '2026-08'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);
    act(() => result.current.refetch());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});

// ── Spec 037 — vários meses, cache por mês, falha isolada ────────────────────────────────────────
function shift(id: string, date: string): AnaCareShift {
  return { id, date, scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'app', status: 'pendiente', anaCareShiftId: id };
}
function patientWith(...shifts: AnaCareShift[]): AnaCarePatient {
  return { anaCareId: '90000', linked: true, name: 'Lucía', providers: [{ anaCareId: 'p1', linked: true, shifts }] };
}
const RETRATO = { updatedAt: '2026-10-01T08:00:00-03:00', stale: false, snapshotState: 'fresco' as const, circuitBreakerOpen: false };
function multiMonthService(byMonth: Record<string, AnaCarePatient | null | Error>) {
  const getPatientMonth = vitestVi.fn(async (month: string) => {
    const v = byMonth[month];
    if (v instanceof Error) throw v;
    return v ?? null;
  });
  const getRetratoStatus = vitestVi.fn().mockResolvedValue(RETRATO);
  const service: AnaCareHoursService = { getMonthSnapshot: vitestVi.fn(), getPatientMonth, getRetratoStatus, validateShift: vitestVi.fn(), validateBatch: vitestVi.fn(), contestShift: vitestVi.fn() };
  return { service, getPatientMonth, getRetratoStatus };
}
const monthsCalled = (fn: { mock: { calls: unknown[][] } }): string[] => fn.mock.calls.map((c) => c[0] as string);

describe('useAnaCareHoursPatient — vários meses (spec 037)', () => {
  beforeEach(() => {
    vitestVi.useFakeTimers({ toFake: ['Date'] });
    vitestVi.setSystemTime(new Date('2026-10-01T12:00:00-03:00'));
  });
  afterEach(() => {
    vitestVi.useRealTimers();
  });

  it('(a) semana só em setembro: busca setembro e NUNCA outubro', async () => {
    const { service, getPatientMonth } = multiMonthService({ '2026-09': patientWith(shift('a', '2026-09-08')) });
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-09'], '2026-09'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(monthsCalled(getPatientMonth)).toEqual(['2026-09']);
  });

  it('(b)+(c) semana cruzada busca setembro e outubro UMA vez cada; voltar à semana de setembro não rebusca', async () => {
    const { service, getPatientMonth, getRetratoStatus } = multiMonthService({
      '2026-09': patientWith(shift('a', '2026-09-30')),
      '2026-10': patientWith(shift('b', '2026-10-01')),
    });
    const { result, rerender } = renderHook(({ months }) => useAnaCareHoursPatient(service, '90000', months, '2026-09'), { initialProps: { months: ['2026-09'] } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ months: ['2026-09', '2026-10'] });
    await waitFor(() => expect(result.current.monthStates['2026-10']?.state).toBe('ok'));
    rerender({ months: ['2026-09'] });
    rerender({ months: ['2026-09', '2026-10'] });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(monthsCalled(getPatientMonth).sort()).toEqual(['2026-09', '2026-10']);
    // retrato só do mês da URL
    expect(monthsCalled(getRetratoStatus)).toEqual(['2026-09']);
    // merge: turnos dos dois meses no mesmo prestador
    expect(result.current.patient?.providers).toHaveLength(1);
    expect(result.current.patient?.providers[0].shifts.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('(d) falha de outubro mantém setembro ok e NÃO vira mês vazio; sem erro de tela inteira', async () => {
    const { service } = multiMonthService({ '2026-09': patientWith(shift('a', '2026-09-30')), '2026-10': new Error('Ana Care fora do ar') });
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-09', '2026-10'], '2026-09'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.monthStates['2026-09'].state).toBe('ok');
    expect(result.current.monthStates['2026-10']).toEqual({ state: 'error', error: 'Ana Care fora do ar' });
    expect(result.current.error).toBeNull();
    expect(result.current.patient?.providers[0].shifts.map((s) => s.id)).toEqual(['a']);
  });

  it('(d2) falha do mês da URL na 1ª carga (nada para mostrar) vira erro de tela inteira', async () => {
    const { service } = multiMonthService({ '2026-09': new Error('falhou') });
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-09'], '2026-09'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('falhou');
  });

  it('(e) retryMonth refaz SÓ o mês que falhou', async () => {
    const byMonth: Record<string, AnaCarePatient | null | Error> = { '2026-09': patientWith(shift('a', '2026-09-30')), '2026-10': new Error('x') };
    const { service, getPatientMonth } = multiMonthService(byMonth);
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-09', '2026-10'], '2026-09'));
    await waitFor(() => expect(result.current.monthStates['2026-10']?.state).toBe('error'));
    byMonth['2026-10'] = patientWith(shift('b', '2026-10-01'));
    act(() => result.current.retryMonth('2026-10'));
    await waitFor(() => expect(result.current.monthStates['2026-10'].state).toBe('ok'));
    expect(monthsCalled(getPatientMonth).sort()).toEqual(['2026-09', '2026-10', '2026-10']);
  });

  it('(f) refetch refaz TODOS os meses carregados (e o retrato do mês da URL)', async () => {
    const { service, getPatientMonth, getRetratoStatus } = multiMonthService({ '2026-09': patientWith(shift('a', '2026-09-30')), '2026-10': patientWith(shift('b', '2026-10-01')) });
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-09', '2026-10'], '2026-09'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.refetch());
    await waitFor(() => expect(getPatientMonth).toHaveBeenCalledTimes(4));
    expect(monthsCalled(getPatientMonth).sort()).toEqual(['2026-09', '2026-09', '2026-10', '2026-10']);
    expect(getRetratoStatus).toHaveBeenCalledTimes(2);
  });

  it('(g) trocar de paciente zera o cache e busca de novo', async () => {
    const { service, getPatientMonth } = multiMonthService({ '2026-09': patientWith(shift('a', '2026-09-30')) });
    const { result, rerender } = renderHook(({ id }) => useAnaCareHoursPatient(service, id, ['2026-09'], '2026-09'), { initialProps: { id: '90000' } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ id: '90001' });
    await waitFor(() => expect(getPatientMonth).toHaveBeenCalledTimes(2));
    expect((getPatientMonth.mock.calls as unknown as string[][]).map((c) => c[1])).toEqual(['90000', '90001']);
  });

  it('mês fora do intervalo (piso 2026-08 / teto = mês corrente) NUNCA é buscado', async () => {
    const { service, getPatientMonth } = multiMonthService({ '2026-09': patientWith(shift('a', '2026-09-30')) });
    const { result } = renderHook(() => useAnaCareHoursPatient(service, '90000', ['2026-07', '2026-09', '2026-11', 'abc'], '2026-09'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(monthsCalled(getPatientMonth)).toEqual(['2026-09']);
  });
  it('(h) falha SÓ do retrato do mês da URL: os turnos seguem "ok" (não vira falha de turnos) e `error` traz o texto do próprio retrato', async () => {
    const { service, getRetratoStatus } = multiMonthService({ '2026-08': patientWith(shift('a', '2026-08-31')), '2026-09': patientWith(shift('b', '2026-09-01')) });
    getRetratoStatus.mockImplementation(async (month: string) => {
      if (month === '2026-09') throw new Error('retrato fora do ar');
      return RETRATO;
    });
    const { result, rerender } = renderHook(({ months, rm }) => useAnaCareHoursPatient(service, '90000', months, rm), { initialProps: { months: ['2026-08'], rm: '2026-08' } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ months: ['2026-08', '2026-09'], rm: '2026-09' });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.monthStates['2026-09']).toEqual({ state: 'ok', error: null });
    expect(result.current.error).toBeNull(); // sem tela inteira: há turnos
    expect(result.current.retratoError).toBe('retrato fora do ar');
    expect(result.current.provisionalSnapshot?.patients).toHaveLength(1);
  });

  it('(i) o retrato exibido é SEMPRE o do mês da URL: enquanto o do mês novo não chegou, não há snapshot (carregando), nunca o retrato de outro mês', async () => {
    const velho = { ...RETRATO, stale: true, snapshotState: 'velho' as const };
    let resolveSep: (v: typeof RETRATO) => void = () => {};
    const { service, getRetratoStatus } = multiMonthService({ '2026-08': patientWith(shift('a', '2026-08-31')), '2026-09': patientWith(shift('b', '2026-09-01')) });
    getRetratoStatus.mockImplementation((month: string) => (month === '2026-08' ? Promise.resolve(velho) : new Promise((r) => { resolveSep = r; })));
    const { result, rerender } = renderHook(({ months, rm }) => useAnaCareHoursPatient(service, '90000', months, rm), { initialProps: { months: ['2026-08'], rm: '2026-08' } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.snapshot?.snapshotState).toBe('velho');
    rerender({ months: ['2026-08', '2026-09'], rm: '2026-09' });
    await waitFor(() => expect(result.current.monthStates['2026-09']?.state).toBe('ok'));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.isLoading).toBe(true);
    await act(async () => resolveSep({ ...RETRATO, snapshotState: 'fresco' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.snapshot).toMatchObject({ month: '2026-09', snapshotState: 'fresco' });
  });
});
