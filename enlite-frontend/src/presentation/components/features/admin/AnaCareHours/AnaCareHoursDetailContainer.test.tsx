import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AnaCareHoursDetailContainer } from './AnaCareHoursDetailContainer';
import { AnaCareHoursServiceError, FakeAnaCareHoursService } from './AnaCareHoursService';
import type { AnaCareHoursService } from './AnaCareHoursService';
import type { AnaCareMonthSnapshot } from './types';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? key.concat('|', Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',')) : key,
  }),
}));

// jsdom não implementa ResizeObserver — AnaCareHoursDetailPage (renderizado pelo container) usa
// para medir a barra de seleção fixa.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as any).ResizeObserver = ResizeObserverStub;

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

// Fábrica (não const compartilhada!): o FakeAnaCareHoursService MUTA os turnos in-place — um
// snapshot compartilhado entre testes vazaria o "validado" de um teste pro próximo.
function makeSnapshot(): AnaCareMonthSnapshot {
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
  };
}

describe('AnaCareHoursDetailContainer', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('POSITIVO — engine OFF: ações permitidas por padrão (fail-open), sem aviso de célula', async () => {
    comEnforcement([], 'off');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).not.toBeDisabled());
    expect(screen.queryByText('admin.anacareHours.error.noValidateCell')).not.toBeInTheDocument();
  });

  it('🔴 NEGATIVO — engine ON sem anacare_hours:validate: ações desabilitadas com motivo visível (D344)', async () => {
    comEnforcement(['anacare_hours:read'], 'on');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeDisabled());
    expect(screen.getByTestId('anacare-hours-disable-reason-p1')).toHaveTextContent('reason=admin.anacareHours.error.noValidateCell');
  });

  it('POSITIVO — engine ON com anacare_hours:validate: valida um turno e refaz o fetch', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const spy = vi.spyOn(service, 'validateShift');
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ shiftId: 's1' }));
    // refetch trouxe o turno já VALIDADO — o botão "Validar" some (regra travada: validado congela).
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-validate-shift-s1')).not.toBeInTheDocument());
  });

  it('NEGATIVO — falha de negócio na validação mostra o erro de ação, sem quebrar a tela', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockResolvedValue(makeSnapshot().patients[0]),
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: makeSnapshot().updatedAt, stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn().mockRejectedValue(new AnaCareHoursServiceError('JA_VALIDADO', 'já validado, não pode reabrir')),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'));
    await waitFor(() => expect(screen.getByTestId('anacare-hours-action-error')).toHaveTextContent('já validado, não pode reabrir'));
  });

  it('NEGATIVO — falha SEM AnaCareHoursServiceError cai no texto genérico i18n', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockResolvedValue(makeSnapshot().patients[0]),
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: makeSnapshot().updatedAt, stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn().mockRejectedValue(new Error('boom')),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'));
    await waitFor(() => expect(screen.getByTestId('anacare-hours-action-error')).toHaveTextContent('admin.anacareHours.error.validateShift'));
  });

  it('POSITIVO — validar em lote chama service.validateBatch', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const spy = vi.spyOn(service, 'validateBatch');
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ shiftIds: ['s1'] }));
  });

  it('POSITIVO — contestar chama service.contestShift com reason e note trimados', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const spy = vi.spyOn(service, 'contestShift');
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-contest-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-contest-shift-s1'));
    fireEvent.change(screen.getByTestId('anacare-hours-contest-reason'), { target: { value: 'otro' } });
    fireEvent.change(screen.getByTestId('anacare-hours-contest-note'), { target: { value: '  nota  ' } });
    fireEvent.click(screen.getByTestId('anacare-hours-contest-confirm'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ shiftId: 's1', reason: 'otro', note: 'nota' }));
  });

  it('POSITIVO — loading depois erro depois snapshot ausente (mês sem paciente E sem retrato) não renderiza nada quebrado', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockResolvedValue(null),
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: '2026-08-01T00:00:00Z', stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="no-existe" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/detail\.patientNotFound/)).toBeInTheDocument());
  });

  it('NEGATIVO — erro 503 no load mostra a mensagem traduzida', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockRejectedValue(new AnaCareHoursServiceError('FONTE_NAO_CONFIGURADA', 'x')),
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: '', stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-detail-error')).toHaveTextContent('admin.anacareHours.error.sourceNotConfigured'));
  });

  it('POSITIVO — "Volver" chama onBack', async () => {
    comEnforcement([], 'off');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const onBack = vi.fn();
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-back')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-back'));
    expect(onBack).toHaveBeenCalled();
  });
});
