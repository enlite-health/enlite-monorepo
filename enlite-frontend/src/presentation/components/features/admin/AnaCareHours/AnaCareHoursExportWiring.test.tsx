/**
 * Spec 032 (T2.7) — fiação do botão "Exportar" na LISTA e no DETALHE, com `FakeAnaCareHoursService`
 * (o retrato do Fake devolve `patients`) e um serviço de exportação espião. `t` devolve a chave.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => (typeof opts === 'string' ? opts : opts ? `${key}|${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',')}` : key),
    i18n: { language: 'es' },
  }),
}));

class ResizeObserverStub { observe(): void {} unobserve(): void {} disconnect(): void {} }
(globalThis as any).ResizeObserver = ResizeObserverStub;

import { AnaCareHoursListContainer } from './AnaCareHoursListContainer';
import { AnaCareHoursDetailContainer } from './AnaCareHoursDetailContainer';
import { FakeAnaCareHoursService } from './AnaCareHoursService';
import type { AnaCareHoursExportService, ExportPatientRangeCommand } from './AnaCareHoursExportService';
import type { AnaCareHoursPatientSnapshot, AnaCarePatient } from './types';

function patient(anaCareId: string): AnaCarePatient {
  return {
    anaCareId, linked: true, name: undefined as unknown as string,
    providers: [{ anaCareId: `n-${anaCareId}`, linked: true, name: 'Rocío García QA', shifts: [{ id: `s-${anaCareId}`, date: '2026-08-14', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'app', status: 'pendiente', anaCareShiftId: '1' }] }],
  } as AnaCarePatient;
}

const SNAPSHOT: AnaCareHoursPatientSnapshot = {
  month: '2026-08', updatedAt: '2026-09-15T08:00:00-03:00', stale: false, snapshotState: 'fresco', circuitBreakerOpen: false,
  patients: [patient('AC-PAT-0'), patient('AC-PAT-6')],
};

const exportService = (): AnaCareHoursExportService & { exportPatientRange: Mock<[ExportPatientRangeCommand], Promise<void>> } => ({
  exportPatientRange: vi.fn<[ExportPatientRangeCommand], Promise<void>>(async () => undefined),
});
const AXONICO = { enviarComprobante: vi.fn() };
const DOC = { registerDocument: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-08-14T12:00:00-03:00'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('botão Exportar — LISTA', () => {
  it('POSITIVO — com `exportService` aparece e o diálogo traz os pacientes do snapshot e o mês da lista', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    const getMonth = vi.spyOn(service, 'getMonthSnapshot');
    render(<AnaCareHoursListContainer service={service} exportService={exportService()} onOpenPatient={vi.fn()} initialMonth="2026-08" />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-export-button')).toBeEnabled());
    await user.click(screen.getByTestId('anacare-hours-export-button'));
    expect(screen.getByTestId('anacare-hours-export-desde')).toHaveValue('2026-08-01');
    expect(screen.getByTestId('anacare-hours-export-hasta')).toHaveValue('2026-08-31');
    await user.click(screen.getByTestId('anacare-hours-export-patient'));
    expect(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-0')).toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-6')).toBeInTheDocument();
    expect(getMonth).toHaveBeenCalledTimes(1); // zero GET novo: o diálogo usa o snapshot que a lista já tem
  });

  it('NEGATIVO — sem `exportService` a lista não mostra o botão', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    render(<AnaCareHoursListContainer service={service} onOpenPatient={vi.fn()} initialMonth="2026-08" />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-patient-row-AC-PAT-0')).toBeInTheDocument());
    expect(screen.queryByTestId('anacare-hours-export-button')).not.toBeInTheDocument();
  });
});

describe('botão Exportar — DETALHE', () => {
  it('POSITIVO — pré-preenche paciente e mês; os pacientes do diálogo vêm do retrato (sem GET novo)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    const getRetrato = vi.spyOn(service, 'getRetratoStatus');
    const getMonth = vi.spyOn(service, 'getMonthSnapshot');
    render(<AnaCareHoursDetailContainer service={service} axonicoService={AXONICO} patientDocumentService={DOC} exportService={exportService()} month="2026-08" patientId="AC-PAT-0" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-export-button')).toBeEnabled());
    await user.click(screen.getByTestId('anacare-hours-export-button'));
    expect(screen.getByTestId('anacare-hours-export-patient')).toHaveValue('Sin vínculo · ID AC-PAT-0');
    expect(screen.getByTestId('anacare-hours-export-desde')).toHaveValue('2026-08-01');
    expect(screen.getByTestId('anacare-hours-export-hasta')).toHaveValue('2026-08-31');
    await user.click(screen.getByTestId('anacare-hours-export-patient'));
    await user.clear(screen.getByTestId('anacare-hours-export-patient'));
    expect(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-6')).toBeInTheDocument();
    expect(getRetrato).toHaveBeenCalledTimes(1);
    expect(getMonth).not.toHaveBeenCalled();
  });

  it('POSITIVO — no detalhe de A, trocar para B no diálogo exporta B (e não navega)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    const exp = exportService();
    const onBack = vi.fn();
    render(<AnaCareHoursDetailContainer service={service} axonicoService={AXONICO} patientDocumentService={DOC} exportService={exp} month="2026-08" patientId="AC-PAT-0" onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-export-button')).toBeEnabled());
    await user.click(screen.getByTestId('anacare-hours-export-button'));
    const input = screen.getByTestId('anacare-hours-export-patient');
    await user.click(input);
    await user.clear(input);
    await user.keyboard('AC-PAT-6');
    await user.click(screen.getByTestId('anacare-hours-export-patient-option-AC-PAT-6'));
    await user.click(screen.getByTestId('anacare-hours-export-confirm'));
    expect(exp.exportPatientRange).toHaveBeenCalledWith({ patientId: 'AC-PAT-6', desde: '2026-08-01', hasta: '2026-08-31' });
    expect(onBack).not.toHaveBeenCalled();
  });

  it('NEGATIVO — sem `exportService` o detalhe não mostra o botão', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    render(<AnaCareHoursDetailContainer service={service} axonicoService={AXONICO} patientDocumentService={DOC} month="2026-08" patientId="AC-PAT-0" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-back')).toBeInTheDocument());
    expect(screen.queryByTestId('anacare-hours-export-button')).not.toBeInTheDocument();
  });

  it('NEGATIVO — retrato real ainda não chegou: desabilitado com `awaitingRetrato` visível', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': SNAPSHOT });
    vi.spyOn(service, 'getRetratoStatus').mockImplementation(() => new Promise(() => undefined));
    render(<AnaCareHoursDetailContainer service={service} axonicoService={AXONICO} patientDocumentService={DOC} exportService={exportService()} month="2026-08" patientId="AC-PAT-0" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-export-button')).toBeInTheDocument());
    expect(screen.getByTestId('anacare-hours-export-button')).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-export-disabled-reason')).toHaveTextContent('admin.anacareHours.error.awaitingRetrato|month=2026-08');
  });
});
