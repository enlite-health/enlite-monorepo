import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AnaCareHoursListContainer } from './AnaCareHoursListContainer';
import { AnaCareHoursServiceError, FakeAnaCareHoursService } from './AnaCareHoursService';
import type { AnaCareHoursService } from './AnaCareHoursService';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('AnaCareHoursListContainer', () => {
  it('POSITIVO — mostra loading e depois a lista', async () => {
    const service = new FakeAnaCareHoursService({});
    render(<AnaCareHoursListContainer service={service} onOpenPatient={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-list-loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-list-loading')).not.toBeInTheDocument());
  });

  it('POSITIVO — clicar num paciente chama onOpenPatient', async () => {
    const service = new FakeAnaCareHoursService({
      '2026-08': {
        month: '2026-08',
        updatedAt: '2026-09-15T08:00:00-03:00',
        stale: false,
        circuitBreakerOpen: false,
        patients: [{ anaCareId: '90000', providers: [] }],
      },
    });
    const onOpenPatient = vi.fn();
    render(<AnaCareHoursListContainer service={service} onOpenPatient={onOpenPatient} initialMonth="2026-08" />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-patient-row-90000')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-patient-row-90000'));
    expect(onOpenPatient).toHaveBeenCalledWith('90000');
  });

  it('NEGATIVO — erro genérico mostra a mensagem crua', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn().mockRejectedValue(new Error('falhou geral')),
      getPatientMonth: vi.fn(),
      getRetratoStatus: vi.fn(),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursListContainer service={service} onOpenPatient={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-list-error')).toHaveTextContent('falhou geral'));
  });

  it('NEGATIVO — 503 ANACARE_SOURCE_NOT_CONFIGURED vira mensagem TRADUZIDA, nunca tela branca', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn().mockRejectedValue(new AnaCareHoursServiceError('FONTE_NAO_CONFIGURADA', 'x')),
      getPatientMonth: vi.fn(),
      getRetratoStatus: vi.fn(),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursListContainer service={service} onOpenPatient={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-list-error')).toHaveTextContent('admin.anacareHours.error.sourceNotConfigured'));
  });

  // D5 (cobertura, 15/09): `!snapshot` sem erro/loading (56-57) — contrato quebrado onde
  // `getMonthSnapshot` resolve algo sem forma (nunca deveria, mas o container não confia cegamente).
  it('POSITIVO — getMonthSnapshot resolve algo sem forma (null) → PageContainer vazio, sem quebrar', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn().mockResolvedValue(null as any),
      getPatientMonth: vi.fn(),
      getRetratoStatus: vi.fn(),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    const { container } = render(<AnaCareHoursListContainer service={service} onOpenPatient={vi.fn()} />);
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-list-loading')).not.toBeInTheDocument());
    expect(screen.queryByTestId('anacare-hours-list-error')).not.toBeInTheDocument();
    expect(container.textContent).toBe('');
  });
});
