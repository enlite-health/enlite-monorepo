/**
 * Spec 037 — navegação do detalhe por mês: rótulo do mês, total só do mês da data selecionada,
 * limites, e os estados carregando/erro que NUNCA viram "sin turnos".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AnaCareHoursDetailPageWithNav as AnaCareHoursDetailPage } from './AnaCareHoursDetailPage.testHarness';
import type { AnaCareHoursPatientSnapshot, AnaCareShift } from './types';
import type { MonthStatus } from '@hooks/admin/useAnaCareHoursPatient';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key), i18n: { language: 'es' } }),
}));

const AXONICO = { enviarComprobante: vi.fn() };
const DOCUMENT = { registerDocument: vi.fn() };

function shift(id: string, date: string, hours = 8): AnaCareShift {
  return { id, date, scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: hours, hoursScheduled: hours, origin: 'app', status: 'pendiente', anaCareShiftId: id };
}

function snapshot(month: string, shifts: AnaCareShift[]): AnaCareHoursPatientSnapshot {
  return {
    month,
    updatedAt: '2026-10-01T08:00:00-03:00',
    stale: false,
    snapshotState: 'fresco',
    circuitBreakerOpen: false,
    patients: [{ anaCareId: '90000', linked: true, name: 'Lucía QA', providers: [{ anaCareId: 'p1', linked: true, name: 'Rocío QA', shifts }] }],
  };
}

const SEP_OCT = [shift('a', '2026-09-29'), shift('b', '2026-09-30'), shift('c', '2026-10-01', 4), shift('d', '2026-10-03', 4)];

function renderPage(month: string, extra: Partial<React.ComponentProps<typeof AnaCareHoursDetailPage>> = {}) {
  return render(
    <AnaCareHoursDetailPage axonicoService={AXONICO} patientDocumentService={DOCUMENT} snapshot={snapshot(month, SEP_OCT)} patientId="90000" onBack={vi.fn()} {...extra} />,
  );
}
const setDate = (value: string) => fireEvent.change(screen.getByTestId('anacare-hours-week-datepicker'), { target: { value } });
const totalLabel = () => screen.getByText(/detail\.totalHoursLabel/).textContent;

describe('AnaCareHoursDetailPage — navegação por mês (spec 037)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00-03:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rótulo "Horas totales de {mês}" diz setembro e muda para outubro ao selecionar 01/10', () => {
    renderPage('2026-09');
    expect(totalLabel()).toContain('"month":"Septiembre 2026"');
    setDate('2026-10-01');
    expect(totalLabel()).toContain('"month":"Octubre 2026"');
  });

  it('semana cruzando meses mostra os 7 dias com turnos dos dois meses e o total soma SÓ o mês da data selecionada', () => {
    renderPage('2026-09');
    setDate('2026-09-30'); // semana 28/09 a 04/10
    for (const day of ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-03']) {
      expect(screen.getByTestId(`anacare-hours-day-group-${day}`)).toBeInTheDocument();
    }
    // setembro = 8 + 8 h (os 4 + 4 h de outubro NÃO entram, mesmo estando na tela)
    expect(screen.getByRole('heading', { level: 2, name: '16.0 h' })).toBeInTheDocument();
    setDate('2026-10-02');
    expect(screen.getByRole('heading', { level: 2, name: '8.0 h' })).toBeInTheDocument();
  });

  it('o seletor expõe min=2026-08-01 e max=último dia do mês corrente', () => {
    renderPage('2026-09');
    const picker = screen.getByTestId('anacare-hours-week-datepicker');
    expect(picker).toHaveAttribute('min', '2026-08-01');
    expect(picker).toHaveAttribute('max', '2026-10-31');
  });

  it('"Semana anterior" fica desabilitada com a data 03/08 (menos 7 dias cairia antes de 01/08) e "Próxima" no teto do mês corrente', () => {
    renderPage('2026-08');
    setDate('2026-08-03');
    expect(screen.getByTestId('anacare-hours-week-prev')).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-week-next')).toBeEnabled();
    setDate('2026-10-28');
    expect(screen.getByTestId('anacare-hours-week-next')).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-week-prev')).toBeEnabled();
  });

  it('digitar o ano aos poucos (valores parciais fora do intervalo) NÃO navega nem reescreve o campo; a data completa navega', () => {
    renderPage('2026-09');
    const picker = screen.getByTestId('anacare-hours-week-datepicker');
    const labelBefore = screen.getByTestId('anacare-hours-week-label').textContent;
    for (const partial of ['0002-09-07', '0020-09-07', '0202-09-07']) {
      setDate(partial);
      expect(picker).toHaveValue(partial);
      expect(screen.getByTestId('anacare-hours-week-label').textContent).toBe(labelBefore);
    }
    setDate('2026-09-07');
    expect(picker).toHaveValue('2026-09-07');
    expect(screen.getByTestId('anacare-hours-week-label').textContent).not.toBe(labelBefore);
  });

  it('mês da semana em voo: mostra CARREGANDO e nunca "sin turnos"', () => {
    const states: Record<string, MonthStatus> = { '2026-09': { state: 'ok', error: null }, '2026-10': { state: 'loading', error: null } };
    renderPage('2026-09', { weekMonthStates: states });
    setDate('2026-09-30');
    expect(screen.getByTestId('anacare-hours-week-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-week-empty')).not.toBeInTheDocument();
  });

  it('mês da semana falhou: erro com "Reintentar", os dias de setembro continuam na tela e NUNCA "sin turnos"', () => {
    const onRetryMonth = vi.fn();
    const states: Record<string, MonthStatus> = { '2026-09': { state: 'ok', error: null }, '2026-10': { state: 'error', error: 'caiu' } };
    renderPage('2026-09', { weekMonthStates: states, onRetryMonth });
    setDate('2026-09-30');
    const error = screen.getByTestId('anacare-hours-week-error');
    expect(within(error).getByText(/weekMonthError/)).toHaveTextContent('Octubre 2026');
    expect(screen.queryByTestId('anacare-hours-week-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-day-group-2026-09-30')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anacare-hours-week-retry-2026-10'));
    expect(onRetryMonth).toHaveBeenCalledWith('2026-10');
  });

  it('semana sem turno com TODOS os meses ok continua mostrando "sin turnos"', () => {
    renderPage('2026-09');
    setDate('2026-09-15');
    expect(screen.getByTestId('anacare-hours-week-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-week-loading')).not.toBeInTheDocument();
  });

  it('seleção em lote atravessa a troca de semana (e de mês): validar chama onValidateBatch com o id do turno de setembro', () => {
    const onValidateBatch = vi.fn();
    renderPage('2026-09', { onValidateBatch });
    setDate('2026-09-30');
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-b'));
    setDate('2026-10-07'); // semana seguinte, outro mês
    expect(screen.getByTestId('anacare-hours-selection-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    expect(onValidateBatch).toHaveBeenCalledWith(['b']);
  });
});
