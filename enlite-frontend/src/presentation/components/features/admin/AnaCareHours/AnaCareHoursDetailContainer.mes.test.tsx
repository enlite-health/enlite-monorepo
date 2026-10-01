/**
 * Spec 037 — o container liga a data selecionada à busca por mês: navegar para fora do mês BUSCA o
 * mês novo (nunca filtra para vazio), a falha de um mês é inline e as ações refazem os meses carregados.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AnaCareHoursDetailContainer } from './AnaCareHoursDetailContainer';
import type { AnaCareHoursService } from './AnaCareHoursService';
import type { AnaCarePatient, AnaCareShift } from './types';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => (typeof opts === 'string' ? opts : opts ? `${key}|${JSON.stringify(opts)}` : key),
    i18n: { language: 'es' },
  }),
}));

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;

const AXONICO = { enviarComprobante: vi.fn() };
const DOCUMENT = { registerDocument: vi.fn() };

function shift(id: string, date: string): AnaCareShift {
  return { id, date, scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'app', status: 'pendiente', anaCareShiftId: id };
}
const patientOf = (...shifts: AnaCareShift[]): AnaCarePatient => ({ anaCareId: '90000', linked: true, name: 'Lucía QA', providers: [{ anaCareId: 'p1', linked: true, shifts }] });

function makeService(byMonth: Record<string, AnaCarePatient | Error>) {
  const getPatientMonth = vi.fn(async (month: string) => {
    const v = byMonth[month];
    if (v instanceof Error) throw v;
    return v ?? null;
  });
  const service: AnaCareHoursService = {
    getMonthSnapshot: vi.fn(),
    getPatientMonth,
    getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: '2026-10-01T08:00:00-03:00', stale: false, snapshotState: 'fresco', circuitBreakerOpen: false }),
    validateShift: vi.fn().mockResolvedValue(undefined),
    validateBatch: vi.fn(),
    contestShift: vi.fn(),
  };
  return { service, getPatientMonth };
}
const calledMonths = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map((c) => c[0] as string);
const setDate = (value: string) => fireEvent.change(screen.getByTestId('anacare-hours-week-datepicker'), { target: { value } });

function mount(service: AnaCareHoursService, onMonthChange = vi.fn()) {
  render(<AnaCareHoursDetailContainer axonicoService={AXONICO} patientDocumentService={DOCUMENT} service={service} month="2026-09" onMonthChange={onMonthChange} patientId="90000" onBack={vi.fn()} />);
  return onMonthChange;
}

describe('AnaCareHoursDetailContainer — navegação por mês (spec 037)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-01T12:00:00-03:00'));
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], countries: [], groups: [], features: {}, enforcement: 'off' } as AuthzContract,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('semana dentro de setembro: NUNCA busca outubro', async () => {
    const { service, getPatientMonth } = makeService({ '2026-09': patientOf(shift('a', '2026-09-09')) });
    mount(service);
    await waitFor(() => expect(screen.getByTestId("anacare-hours-week-datepicker")).toBeInTheDocument());
    setDate('2026-09-09');
    await waitFor(() => expect(screen.getByTestId('anacare-hours-shift-row-a')).toBeInTheDocument());
    expect(calledMonths(getPatientMonth)).not.toContain('2026-10');
  });

  it('navegar até a semana 28/09–04/10 BUSCA outubro, mostra os 7 dias dos dois meses e avisa o mês novo', async () => {
    const { service, getPatientMonth } = makeService({
      '2026-09': patientOf(shift('a', '2026-09-30')),
      '2026-10': patientOf(shift('b', '2026-10-01'), shift('c', '2026-10-04')),
    });
    const onMonthChange = mount(service);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-week-datepicker')).toBeInTheDocument());
    setDate('2026-09-30');
    await waitFor(() => expect(screen.getByTestId('anacare-hours-shift-row-b')).toBeInTheDocument());
    for (const id of ['a', 'b', 'c']) expect(screen.getByTestId(`anacare-hours-shift-row-${id}`)).toBeInTheDocument();
    expect(calledMonths(getPatientMonth).filter((m) => m === '2026-10')).toHaveLength(1);
    expect(screen.queryByTestId('anacare-hours-week-empty')).not.toBeInTheDocument();
    setDate('2026-10-01');
    expect(onMonthChange).toHaveBeenCalledWith('2026-10');
  });

  it('falha de outubro: erro inline com Reintentar, os dias de setembro continuam e NUNCA "sin turnos"; Reintentar refaz só outubro', async () => {
    const byMonth: Record<string, AnaCarePatient | Error> = { '2026-09': patientOf(shift('a', '2026-09-30')), '2026-10': new Error('Ana Care fora do ar') };
    const { service, getPatientMonth } = makeService(byMonth);
    mount(service);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-week-datepicker')).toBeInTheDocument());
    setDate('2026-09-30');
    await waitFor(() => expect(screen.getByTestId('anacare-hours-week-error')).toBeInTheDocument());
    expect(screen.getByTestId('anacare-hours-shift-row-a')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-week-empty')).not.toBeInTheDocument();
    byMonth['2026-10'] = patientOf(shift('b', '2026-10-01'));
    const septemberCalls = calledMonths(getPatientMonth).filter((m) => m === '2026-09').length;
    fireEvent.click(screen.getByTestId('anacare-hours-week-retry-2026-10'));
    await waitFor(() => expect(screen.getByTestId('anacare-hours-shift-row-b')).toBeInTheDocument());
    expect(screen.queryByTestId('anacare-hours-week-error')).not.toBeInTheDocument();
    expect(calledMonths(getPatientMonth).filter((m) => m === '2026-09')).toHaveLength(septemberCalls);
  });

  it('validar um turno de outubro e "Actualizar" refazem TODOS os meses carregados (setembro e outubro)', async () => {
    const { service, getPatientMonth } = makeService({ '2026-09': patientOf(shift('a', '2026-09-30')), '2026-10': patientOf(shift('b', '2026-10-01')) });
    mount(service);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-week-datepicker')).toBeInTheDocument());
    setDate('2026-09-30');
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-b')).not.toBeDisabled());
    const before = getPatientMonth.mock.calls.length;
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-b'));
    await waitFor(() => expect(service.validateShift).toHaveBeenCalledWith({ shiftId: 'b' }));
    await waitFor(() => expect(getPatientMonth.mock.calls.length).toBeGreaterThan(before));
    const afterValidate = calledMonths(getPatientMonth).slice(before);
    expect(afterValidate).toContain('2026-09');
    expect(afterValidate).toContain('2026-10');
    const mid = getPatientMonth.mock.calls.length;
    fireEvent.click(screen.getByTestId('anacare-hours-refresh'));
    await waitFor(() => expect(getPatientMonth.mock.calls.length).toBeGreaterThanOrEqual(mid + 2));
    expect(calledMonths(getPatientMonth).slice(mid)).toEqual(expect.arrayContaining(['2026-09', '2026-10']));
  });
});
