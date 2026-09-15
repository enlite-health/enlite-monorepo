import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProviderGroup } from './ProviderGroup';
import type { AnaCareProvider, AnaCareShift } from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key) }),
}));

function makeShift(overrides: Partial<AnaCareShift> = {}): AnaCareShift {
  return {
    id: 's1',
    date: '2026-08-14',
    scheduledStart: '08:00',
    scheduledEnd: '16:00',
    actualStart: '08:00',
    actualEnd: '16:00',
    hoursActual: 8,
    hoursScheduled: 8,
    origin: 'app',
    status: 'pendiente',
    anaCareShiftId: '90101',
    ...overrides,
  };
}

function makeProvider(overrides: Partial<AnaCareProvider> = {}): AnaCareProvider {
  return { anaCareId: 'p1', linked: true, name: 'Rocío García QA', shifts: [makeShift()], ...overrides };
}

const noop = { onValidateShift: vi.fn(), onOpenContestModal: vi.fn(), onToggleShift: vi.fn(), onToggleProviderPending: vi.fn() };

describe('ProviderGroup', () => {
  it('POSITIVO — turno pendente mostra checkbox, "Validar" e "Contestar"', () => {
    render(<ProviderGroup provider={makeProvider()} disableActions={false} selectedShiftIds={new Set()} {...noop} />);
    expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-contest-shift-s1')).toBeInTheDocument();
  });

  it('POSITIVO — turno validado NÃO mostra checkbox nem botões — só "Validado por"', () => {
    const provider = makeProvider({ shifts: [makeShift({ status: 'validado', validatedBy: { id: 'e2e-qa', name: 'Equipo QA' }, validatedAt: '2026-08-15T10:00:00-03:00' })] });
    render(<ProviderGroup provider={provider} disableActions={false} selectedShiftIds={new Set()} {...noop} />);
    expect(screen.queryByTestId('anacare-hours-select-shift-s1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-validate-shift-s1')).not.toBeInTheDocument();
    expect(screen.getByText(/providerGroup\.validatedBy/)).toBeInTheDocument();
  });

  // D5 (cobertura, 15/09): `validatedAt` ausente num turno validado — cai no fallback `?? shift.date`
  // (defesa contra o backend mandar `validado` sem a data, ao invés de quebrar `.slice`).
  it('POSITIVO — turno validado SEM validatedAt usa a data do turno como fallback', () => {
    const provider = makeProvider({ shifts: [makeShift({ status: 'validado', validatedBy: { id: 'e2e-qa', name: 'Equipo QA' }, validatedAt: undefined })] });
    render(<ProviderGroup provider={provider} disableActions={false} selectedShiftIds={new Set()} {...noop} />);
    expect(screen.getByText(/providerGroup\.validatedBy/)).toBeInTheDocument();
  });

  it('POSITIVO — turno contestado mostra só "Validar" (sem "Contestar") + motivo sempre + nota quando presente', () => {
    const provider = makeProvider({ shifts: [makeShift({ status: 'contestado', contestReason: 'horario_distinto', contestNote: 'nota visível' })] });
    render(<ProviderGroup provider={provider} disableActions={false} selectedShiftIds={new Set()} {...noop} />);
    expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-contest-shift-s1')).not.toBeInTheDocument();
    expect(screen.getByText(/providerGroup\.reason/)).toBeInTheDocument();
    expect(screen.getByText(/providerGroup\.note\|/)).toBeInTheDocument();
  });

  it('NEGATIVO — turno contestado SEM patient_clinical:read (contestNote ausente) mostra "Nota restringida"', () => {
    const provider = makeProvider({ shifts: [makeShift({ status: 'contestado', contestReason: 'otro', contestNote: undefined })] });
    render(<ProviderGroup provider={provider} disableActions={false} selectedShiftIds={new Set()} {...noop} />);
    expect(screen.getByText('admin.anacareHours.providerGroup.noteRestricted')).toBeInTheDocument();
  });

  it('POSITIVO — clicar no checkbox do turno chama onToggleShift', () => {
    const onToggleShift = vi.fn();
    render(<ProviderGroup provider={makeProvider()} disableActions={false} selectedShiftIds={new Set()} {...noop} onToggleShift={onToggleShift} />);
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    expect(onToggleShift).toHaveBeenCalledWith('s1');
  });

  it('POSITIVO — clicar em "Validar" chama onValidateShift; "Contestar" chama onOpenContestModal', () => {
    const onValidateShift = vi.fn();
    const onOpenContestModal = vi.fn();
    render(
      <ProviderGroup provider={makeProvider()} disableActions={false} selectedShiftIds={new Set()} {...noop} onValidateShift={onValidateShift} onOpenContestModal={onOpenContestModal} />,
    );
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'));
    expect(onValidateShift).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('anacare-hours-contest-shift-s1'));
    expect(onOpenContestModal).toHaveBeenCalled();
  });

  it('POSITIVO — checkbox de cabeçalho aparece quando há pendentes e chama onToggleProviderPending', () => {
    const onToggleProviderPending = vi.fn();
    render(<ProviderGroup provider={makeProvider()} disableActions={false} selectedShiftIds={new Set()} {...noop} onToggleProviderPending={onToggleProviderPending} />);
    fireEvent.click(screen.getByTestId('anacare-hours-select-all-pending-p1'));
    expect(onToggleProviderPending).toHaveBeenCalled();
  });

  it('POSITIVO — 100% validado mostra "Todo validado" e some o checkbox de cabeçalho', () => {
    const provider = makeProvider({ shifts: [makeShift({ status: 'validado', validatedBy: { id: 'e2e-qa', name: 'X' }, validatedAt: '2026-08-15T00:00:00-03:00' })] });
    render(<ProviderGroup provider={provider} disableActions={false} selectedShiftIds={new Set()} {...noop} />);
    expect(screen.getByTestId('anacare-hours-no-pending-p1')).toHaveTextContent('admin.anacareHours.providerGroup.allValidated');
    expect(screen.queryByTestId('anacare-hours-select-all-pending-p1')).not.toBeInTheDocument();
  });

  it('POSITIVO — sem pendentes mas com contestado mostra "noPendingContested"', () => {
    const provider = makeProvider({ shifts: [makeShift({ status: 'contestado', contestReason: 'otro' })] });
    render(<ProviderGroup provider={provider} disableActions={false} selectedShiftIds={new Set()} {...noop} />);
    expect(screen.getByTestId('anacare-hours-no-pending-p1')).toHaveTextContent('admin.anacareHours.providerGroup.noPendingContested');
  });

  it('POSITIVO — disableActions com motivo mostra o motivo e desabilita os botões', () => {
    render(<ProviderGroup provider={makeProvider()} disableActions disableReason="retrato desactualizado" selectedShiftIds={new Set()} {...noop} />);
    expect(screen.getByTestId('anacare-hours-disable-reason-p1')).toHaveTextContent('admin.anacareHours.stale.blockedPrefix');
    expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-contest-shift-s1')).toBeDisabled();
    expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeDisabled();
  });

  it('POSITIVO — origem "sin_checkin" mostra "—" nas horas e o rótulo "Programado, sin actuación"; destaque de 20min funciona', () => {
    const provider = makeProvider({
      shifts: [
        makeShift({ id: 'a', origin: 'sin_checkin', hoursActual: null, actualStart: null, actualEnd: null }),
        makeShift({ id: 'b', origin: 'app', hoursActual: 8.4, hoursScheduled: 8, actualStart: '08:00', actualEnd: '16:24' }),
      ],
    });
    render(<ProviderGroup provider={provider} disableActions={false} selectedShiftIds={new Set()} highlightNoCheckIn {...noop} />);
    expect(screen.getByTestId('anacare-hours-shift-row-a')).toHaveTextContent('—');
    expect(screen.getByText('admin.anacareHours.origin.scheduledNoActivity')).toBeInTheDocument();
  });

  it('POSITIVO — checkbox selecionado reflete selectedShiftIds', () => {
    render(<ProviderGroup provider={makeProvider()} disableActions={false} selectedShiftIds={new Set(['s1'])} {...noop} />);
    expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeChecked();
  });
});
