import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AnaCareHoursDetailContainer } from './AnaCareHoursDetailContainer';
import { AnaCareHoursServiceError, FakeAnaCareHoursService } from './AnaCareHoursService';
import type { AnaCareHoursService } from './AnaCareHoursService';
import type { AnaCareMonthSnapshot } from './types';

/**
 * PORTE PRD (`feat/anacare-horas-prd-allowlist`): o `main` não tem ABAC — o gate por célula
 * (`useActionGate('anacare_hours', 'validate')`) foi removido do container (ver comentário lá).
 * As ações são sempre habilitadas na UI; a checagem REAL é o 403 do servidor
 * (`requireAnaCareHoursAllowlist`), fora do escopo deste componente. Por isso os testes de
 * cenário "engine ON sem célula" e as 2 guardas de corrida do gate (que só faziam sentido com um
 * gate DINÂMICO) saíram daqui — o comportamento que provavam não existe mais neste componente.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // D3: `describeError` chama `t(byCodeKey, fallback)` com o FALLBACK como STRING (convenção do
    // projeto pro "segundo argumento é o fallback pro valor cru", CLAUDE.md §i18n) — o mock
    // precisa devolver essa string quando `opts` não é um objeto de interpolação.
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (typeof opts === 'string') return opts;
      return opts ? key.concat('|', Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(',')) : key;
    },
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
    vi.clearAllMocks();
  });

  it('POSITIVO — ações habilitadas por padrão (sem gate de célula no main), sem aviso de permissão', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).not.toBeDisabled());
    expect(screen.queryByText('admin.anacareHours.error.noValidateCell')).not.toBeInTheDocument();
  });

  it('POSITIVO — valida um turno e refaz o fetch', async () => {
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const spy = vi.spyOn(service, 'validateShift');
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ shiftId: 's1' }));
    // refetch trouxe o turno já VALIDADO — o botão "Validar" some (regra travada: validado congela).
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-validate-shift-s1')).not.toBeInTheDocument());
  });

  it('NEGATIVO — falha de negócio na validação mostra o erro de ação TRADUZIDO POR CÓDIGO, sem quebrar a tela', async () => {
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
    await waitFor(() =>
      expect(screen.getByTestId('anacare-hours-action-error')).toHaveTextContent('admin.anacareHours.error.validateShift'),
    );
  });

  it('NEGATIVO — falha SEM AnaCareHoursServiceError cai no texto genérico i18n', async () => {
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
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const spy = vi.spyOn(service, 'validateBatch');
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ shiftIds: ['s1'] }));
  });

  it('NEGATIVO — falha de negócio ao validar em LOTE mostra o erro de ação traduzido por código', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockResolvedValue(makeSnapshot().patients[0]),
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: makeSnapshot().updatedAt, stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn(),
      validateBatch: vi.fn().mockRejectedValue(new AnaCareHoursServiceError('RETRATO_DESATUALIZADO', 'retrato velho')),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('anacare-hours-action-error')).toHaveTextContent('admin.anacareHours.error.validateBatch'),
    );
  });

  it('POSITIVO — contestar chama service.contestShift com reason e note trimados', async () => {
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
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const onBack = vi.fn();
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-back')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('POSITIVO — estado de loading aparece ANTES do fetch resolver', () => {
    let resolvePatient: (v: unknown) => void = () => {};
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn(() => new Promise((resolve) => { resolvePatient = resolve; })) as any,
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: '', stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-detail-loading')).toBeInTheDocument();
    resolvePatient(null); // libera a promise pendente — evita vazar estado pro próximo teste
  });

  it('NEGATIVO — falha de negócio ao CONTESTAR mostra o erro de ação traduzido por código', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockResolvedValue(makeSnapshot().patients[0]),
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: makeSnapshot().updatedAt, stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn().mockRejectedValue(new AnaCareHoursServiceError('MOTIVO_INVALIDO', 'motivo inválido')),
    };
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-contest-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-contest-shift-s1'));
    fireEvent.change(screen.getByTestId('anacare-hours-contest-reason'), { target: { value: 'otro' } });
    fireEvent.click(screen.getByTestId('anacare-hours-contest-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('anacare-hours-action-error')).toHaveTextContent('admin.anacareHours.error.contestShift'),
    );
  });

  it('POSITIVO — retrato resolve sem forma (getRetratoStatus devolve null) → snapshot ausente sem erro nem loading, PageContainer vazio', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockResolvedValue(makeSnapshot().patients[0]),
      getRetratoStatus: vi.fn().mockResolvedValue(null as any),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    const { container } = render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-detail-loading')).not.toBeInTheDocument());
    expect(screen.queryByTestId('anacare-hours-detail-error')).not.toBeInTheDocument();
    expect(container.textContent).toBe('');
  });

  it('NEGATIVO — erro genérico no load (sem FONTE_NAO_CONFIGURADA) mostra o texto cru do hook', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockRejectedValue(new Error('No se pudo cargar el paciente.')),
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: '', stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursDetailContainer service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('anacare-hours-detail-error')).toHaveTextContent('No se pudo cargar el paciente.'),
    );
  });
});
