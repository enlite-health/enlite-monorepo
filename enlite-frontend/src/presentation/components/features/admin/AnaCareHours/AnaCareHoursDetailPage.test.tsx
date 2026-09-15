import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnaCareHoursDetailPage } from './AnaCareHoursDetailPage';
import type { AnaCareMonthSnapshot } from './types';

// jsdom não implementa ResizeObserver — a barra de seleção fixa mede a própria altura com ele
// (ver AnaCareHoursDetailPage.tsx). Stub local, só para este arquivo (nenhum outro componente do
// painel usa ResizeObserver hoje — medido: grep sem match fora desta feature).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key) }),
}));

function snapshot(overrides: Partial<AnaCareMonthSnapshot> = {}): AnaCareMonthSnapshot {
  return {
    month: '2026-08',
    updatedAt: '2026-09-15T08:00:00-03:00',
    stale: false,
    circuitBreakerOpen: false,
    patients: [
      {
        anaCareId: '90000',
        linked: true,
        name: 'Lucía Fernández QA',
        providers: [
          {
            anaCareId: 'p1',
            linked: true,
            name: 'Rocío García QA',
            shifts: [
              {
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
                anaCareShiftId: '1',
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('AnaCareHoursDetailPage', () => {
  it('NEGATIVO — paciente inexistente no snapshot mostra "patientNotFound"', () => {
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="no-existe" onBack={vi.fn()} />);
    expect(screen.getByText(/detail\.patientNotFound/)).toBeInTheDocument();
  });

  it('POSITIVO — voltar chama onBack', () => {
    const onBack = vi.fn();
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={onBack} />);
    fireEvent.click(screen.getByTestId('anacare-hours-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('1.5a (D344) — POSITIVO: sem `blockReasonMode` explícito, o motivo por prestador nasce CURTO ("retrato desactualizado"), nunca o texto longo', () => {
    render(<AnaCareHoursDetailPage snapshot={snapshot({ stale: true })} patientId="90000" onBack={vi.fn()} />);
    // motivo por prestador: texto curto (sem a palavra "horas", que só existe na frase longa)
    const providerReason = screen.getByTestId('anacare-hours-disable-reason-p1');
    expect(providerReason).toHaveTextContent('admin.anacareHours.stale.blockedPrefix');
    expect(providerReason.textContent).not.toMatch(/deshabilitada hasta actualizar/);
  });

  it('1.5a (D344) — POSITIVO: o banner do topo continua com o texto LONGO, mesmo com o padrão curto por prestador', () => {
    render(<AnaCareHoursDetailPage snapshot={snapshot({ stale: true })} patientId="90000" onBack={vi.fn()} />);
    expect(screen.getByText(/deshabilitada hasta actualizar/)).toBeInTheDocument();
  });

  it('1.5a (D344) — POSITIVO: `blockReasonMode="largo"` explícito ainda funciona (função pura preservada)', () => {
    render(<AnaCareHoursDetailPage snapshot={snapshot({ stale: true })} patientId="90000" onBack={vi.fn()} blockReasonMode="largo" />);
    const providerReason = screen.getByTestId('anacare-hours-disable-reason-p1');
    expect(providerReason.textContent).toMatch(/deshabilitada hasta actualizar/);
  });

  it('POSITIVO — disableActionsReason (célula ausente) desabilita ações mesmo com retrato em dia, SEM mostrar o AlertBanner de retrato', () => {
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={vi.fn()} disableActionsReason="Sem permissão" />);
    expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeDisabled();
    expect(screen.queryByText('admin.anacareHours.stale.title')).not.toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-disable-reason-p1')).toHaveTextContent('Sem permissão');
  });

  it('POSITIVO — selecionar um turno mostra a barra fixa; "Limpiar selección" some com ela', () => {
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    expect(screen.queryByTestId('anacare-hours-selection-bar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    expect(screen.getByTestId('anacare-hours-selection-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anacare-hours-selection-clear'));
    expect(screen.queryByTestId('anacare-hours-selection-bar')).not.toBeInTheDocument();
  });

  it('POSITIVO — clicar no MESMO checkbox duas vezes seleciona e depois desmarca (toggle)', () => {
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    const checkbox = screen.getByTestId('anacare-hours-select-shift-s1');
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByTestId('anacare-hours-selection-bar')).not.toBeInTheDocument();
  });

  it('POSITIVO — validar em lote: abre o modal, confirmar chama onValidateBatch e limpa a seleção', () => {
    const onValidateBatch = vi.fn();
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onValidateBatch={onValidateBatch} />);
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    expect(screen.getByTestId('anacare-hours-batch-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    expect(onValidateBatch).toHaveBeenCalledWith(['s1']);
    expect(screen.queryByTestId('anacare-hours-selection-bar')).not.toBeInTheDocument();
  });

  it('POSITIVO — cancelar o modal de lote fecha sem chamar onValidateBatch', () => {
    const onValidateBatch = vi.fn();
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onValidateBatch={onValidateBatch} />);
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-cancel'));
    expect(screen.queryByTestId('anacare-hours-batch-modal')).not.toBeInTheDocument();
    expect(onValidateBatch).not.toHaveBeenCalled();
  });

  it('POSITIVO — validar um turno chama onValidateShift', () => {
    const onValidateShift = vi.fn();
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onValidateShift={onValidateShift} />);
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'));
    expect(onValidateShift).toHaveBeenCalled();
  });

  it('POSITIVO — contestar abre o modal e confirmar chama onContestShift(shiftId, reason, note)', () => {
    const onContestShift = vi.fn();
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onContestShift={onContestShift} />);
    fireEvent.click(screen.getByTestId('anacare-hours-contest-shift-s1'));
    expect(screen.getByTestId('anacare-hours-contest-modal')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('anacare-hours-contest-reason'), { target: { value: 'otro' } });
    fireEvent.click(screen.getByTestId('anacare-hours-contest-confirm'));
    expect(onContestShift).toHaveBeenCalledWith('s1', 'otro', '');
    expect(screen.queryByTestId('anacare-hours-contest-modal')).not.toBeInTheDocument();
  });

  it('POSITIVO — cancelar o modal de contestação fecha sem chamar onContestShift', () => {
    const onContestShift = vi.fn();
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onContestShift={onContestShift} />);
    fireEvent.click(screen.getByTestId('anacare-hours-contest-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-contest-cancel'));
    expect(screen.queryByTestId('anacare-hours-contest-modal')).not.toBeInTheDocument();
    expect(onContestShift).not.toHaveBeenCalled();
  });

  it('POSITIVO — checkbox de cabeçalho do prestador marca todos os pendentes; clicar de novo desmarca', () => {
    const snap = snapshot({
      patients: [
        {
          anaCareId: '90000',
          linked: true,
          name: 'Lucía Fernández QA',
          providers: [
            {
              anaCareId: 'p1',
              linked: true,
              name: 'Rocío García QA',
              shifts: [
                { id: 's1', date: '2026-08-14', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'app', status: 'pendiente', anaCareShiftId: '1' },
                { id: 's2', date: '2026-08-15', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'app', status: 'pendiente', anaCareShiftId: '2' },
              ],
            },
          ],
        },
      ],
    });
    render(<AnaCareHoursDetailPage snapshot={snap} patientId="90000" onBack={vi.fn()} />);
    const headerCheckbox = screen.getByTestId('anacare-hours-select-all-pending-p1');
    fireEvent.click(headerCheckbox); // marca todos (state 'none' -> marca)
    expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeChecked();
    expect(screen.getByTestId('anacare-hours-select-shift-s2')).toBeChecked();
    fireEvent.click(headerCheckbox); // já 'all' -> desmarca todos
    expect(screen.getByTestId('anacare-hours-select-shift-s1')).not.toBeChecked();
    expect(screen.getByTestId('anacare-hours-select-shift-s2')).not.toBeChecked();
  });

  it('POSITIVO — sem callbacks de escrita, os cliques não quebram (no-op)', () => {
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    expect(() => fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'))).not.toThrow();
  });

  it('POSITIVO — resumo com contestados e as 3 origens mostra o sufixo de contestados e as 3 pílulas', () => {
    const snap = snapshot({
      patients: [
        {
          anaCareId: '90000',
          linked: true,
          name: 'Lucía Fernández QA',
          providers: [
            {
              anaCareId: 'p1',
              linked: true,
              name: 'Rocío García QA',
              shifts: [
                { id: 'x1', date: '2026-08-01', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: null, actualEnd: null, hoursActual: null, hoursScheduled: 8, origin: 'sin_checkin', status: 'pendiente', anaCareShiftId: '1' },
                { id: 'x2', date: '2026-08-02', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'web_admin', status: 'contestado', contestReason: 'otro', anaCareShiftId: '2' },
                { id: 'x3', date: '2026-08-03', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'app', status: 'validado', validatedByName: 'Y', validatedAt: '2026-08-04T00:00:00Z', anaCareShiftId: '3' },
              ],
            },
          ],
        },
      ],
    });
    render(<AnaCareHoursDetailPage snapshot={snap} patientId="90000" onBack={vi.fn()} />);
    expect(screen.getByText(/detail\.validationContestedSuffix/)).toBeInTheDocument();
    expect(screen.getAllByText('admin.anacareHours.origin.sinCheckin').length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin.anacareHours.origin.webAdmin').length).toBeGreaterThan(0);
  });

  it('POSITIVO — pílulas de origem só aparecem quando a contagem é > 0', () => {
    render(<AnaCareHoursDetailPage snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    // só 'app' está presente no fixture — sin_checkin/web_admin não devem renderizar pílula.
    expect(screen.getAllByText('admin.anacareHours.origin.app').length).toBeGreaterThan(0);
  });
});
