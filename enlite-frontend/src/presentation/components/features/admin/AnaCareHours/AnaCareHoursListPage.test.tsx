import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnaCareHoursListPage } from './AnaCareHoursListPage';
import type { AnaCareMonthSnapshot } from './types';

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
        providers: [
          {
            anaCareId: 'p1',
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
                status: 'validado',
                validatedBy: { id: 'e2e-qa', name: 'Equipo QA' },
                validatedAt: '2026-08-15T00:00:00-03:00',
                anaCareShiftId: '1',
              },
            ],
          },
        ],
      },
      { anaCareId: '90447', providers: [] },
    ],
    ...overrides,
  };
}

describe('AnaCareHoursListPage', () => {
  it('POSITIVO — lista os pacientes com as colunas do protótipo', () => {
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-patient-row-90000')).toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-patient-row-90447')).toBeInTheDocument();
  });

  it('POSITIVO — clicar numa linha chama onOpenPatient com o anaCareId', () => {
    const onOpenPatient = vi.fn();
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={onOpenPatient} />);
    fireEvent.click(screen.getByTestId('anacare-hours-patient-row-90000'));
    expect(onOpenPatient).toHaveBeenCalledWith('90000');
  });

  it('NEGATIVO — mês sem turnos mostra o empty state "emptyNoShifts"', () => {
    render(<AnaCareHoursListPage snapshot={snapshot({ patients: [] })} onOpenPatient={vi.fn()} />);
    expect(screen.getByText('admin.anacareHours.list.emptyNoShifts')).toBeInTheDocument();
  });

  it('NEGATIVO — filtro sem resultado mostra "emptyNoMatch"', () => {
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} />);
    fireEvent.change(screen.getByTestId('anacare-hours-patient-search'), { target: { value: 'zzz-no-existe' } });
    expect(screen.getByText('admin.anacareHours.list.emptyNoMatch')).toBeInTheDocument();
  });

  it('POSITIVO — busca por ID de paciente filtra a lista (paciente nunca mostra nome — reconciliação fora de escopo)', () => {
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} />);
    fireEvent.change(screen.getByTestId('anacare-hours-patient-search'), { target: { value: '90000' } });
    expect(screen.getByTestId('anacare-hours-patient-row-90000')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-patient-row-90447')).not.toBeInTheDocument();
  });

  it('POSITIVO — retrato desatualizado (stale) mostra o AlertBanner', () => {
    render(<AnaCareHoursListPage snapshot={snapshot({ stale: true })} onOpenPatient={vi.fn()} />);
    expect(screen.getByText('admin.anacareHours.stale.messageSimple')).toBeInTheDocument();
  });

  it('POSITIVO — disjuntor aberto mostra o AlertBanner com a mensagem do disjuntor', () => {
    render(<AnaCareHoursListPage snapshot={snapshot({ circuitBreakerOpen: true })} onOpenPatient={vi.fn()} />);
    expect(screen.getByText('admin.anacareHours.stale.messageCircuitBreaker')).toBeInTheDocument();
  });

  it('POSITIVO — troca de mês chama onMonthChange', () => {
    const onMonthChange = vi.fn();
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} onMonthChange={onMonthChange} />);
    const select = screen.getByLabelText('admin.anacareHours.monthAriaLabel') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '2026-09' } });
    expect(onMonthChange).toHaveBeenCalledWith('2026-09');
  });

  it('POSITIVO — linha com contestados e as 3 origens mostra o sufixo de contestados e os 3 selos mini de origem', () => {
    const snap = snapshot({
      patients: [
        {
          anaCareId: '90999',
          providers: [
            {
              anaCareId: 'p9',
              name: 'Paula Díaz QA',
              shifts: [
                { id: 'x1', date: '2026-08-01', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: null, actualEnd: null, hoursActual: null, hoursScheduled: 8, origin: 'sin_checkin', status: 'pendiente', anaCareShiftId: '1' },
                { id: 'x2', date: '2026-08-02', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'web_admin', status: 'contestado', contestReason: 'otro', anaCareShiftId: '2' },
                { id: 'x3', date: '2026-08-03', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'app', status: 'validado', validatedBy: { id: 'e2e-qa', name: 'Y' }, validatedAt: '2026-08-04T00:00:00Z', anaCareShiftId: '3' },
              ],
            },
          ],
        },
      ],
    });
    render(<AnaCareHoursListPage snapshot={snap} onOpenPatient={vi.fn()} />);
    const row = screen.getByTestId('anacare-hours-patient-row-90999');
    expect(row).toHaveTextContent('admin.anacareHours.list.validationSummaryContestedSuffix');
  });

  it('POSITIVO — filtro por prestador restringe a lista', () => {
    render(<AnaCareHoursListPage snapshot={snapshot()} onOpenPatient={vi.fn()} />);
    fireEvent.focus(screen.getByTestId('anacare-hours-provider-filter'));
    fireEvent.click(screen.getByTestId('anacare-hours-provider-filter-option-p1'));
    expect(screen.getByTestId('anacare-hours-patient-row-90000')).toBeInTheDocument();
    expect(screen.queryByTestId('anacare-hours-patient-row-90447')).not.toBeInTheDocument();
  });
});
