import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { AnaCareHoursDetailContainer } from './AnaCareHoursDetailContainer';
import { AnaCareHoursServiceError, FakeAnaCareHoursService } from './AnaCareHoursService';
import type { AnaCareHoursService } from './AnaCareHoursService';
import type { AxonicoComprobanteService } from './AxonicoComprobanteService';
import type { AnaCarePatientDocumentService } from './AnaCarePatientDocumentService';
import type { AnaCareHoursPatientSnapshot } from './types';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

/** Fake mínimo — este arquivo testa handlers de `AnaCareHoursService` (validar/contestar/sync), nunca o clique em "Enviar" (Axonico é `DayGroup.test.tsx`); só precisa satisfazer a prop obrigatória, REPASSADA sem lógica própria. */
const AXONICO_SERVICE: AxonicoComprobanteService = { enviarComprobante: vi.fn() };
const PATIENT_DOCUMENT_SERVICE: AnaCarePatientDocumentService = { registerDocument: vi.fn() };

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

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

// Fábrica (não const compartilhada!): o FakeAnaCareHoursService MUTA os turnos in-place — um
// snapshot compartilhado entre testes vazaria o "validado" de um teste pro próximo.
function makeSnapshot(): AnaCareHoursPatientSnapshot {
  return {
    month: '2026-08',
    updatedAt: '2026-09-15T08:00:00-03:00',
    stale: false,
    snapshotState: 'fresco',
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
  // Regra nova (18/09, mesmo padrão de AnaCareHoursDetailPage.test.tsx): a semana inicial depende
  // de "hoje" × mês exibido. Todo teste deste arquivo usa month="2026-08" com o único turno do
  // fixture em 2026-08-14 — por isso o relógio fica congelado NESSE dia, para cair na semana de
  // 10-16/08 que os testes esperam (era a semana do "turno mais antigo" no comportamento anterior).
  // shouldAdvanceTime: true porque este arquivo (diferente do DetailPage) usa waitFor/act
  // assíncronos — sem isso o fake timer trava a espera do testing-library.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-14T12:00:00-03:00'));
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSITIVO — engine OFF: ações permitidas por padrão (fail-open), sem aviso de célula', async () => {
    comEnforcement([], 'off');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).not.toBeDisabled());
    expect(screen.queryByText('admin.anacareHours.error.noValidateCell')).not.toBeInTheDocument();
  });

  it('🔴 NEGATIVO — engine ON sem anacare_hours:validate: ações desabilitadas com motivo visível (D344)', async () => {
    comEnforcement(['anacare_hours:read'], 'on');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeDisabled());
    expect(screen.getByTestId('anacare-hours-disable-reason-day-2026-08-14')).toHaveTextContent('reason=admin.anacareHours.error.noValidateCell');
  });

  it('POSITIVO — engine ON com anacare_hours:validate: valida um turno e refaz o fetch', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const spy = vi.spyOn(service, 'validateShift');
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ shiftId: 's1' }));
    // refetch trouxe o turno já VALIDADO — o botão "Validar" some (regra travada: validado congela).
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-validate-shift-s1')).not.toBeInTheDocument());
  });

  it('NEGATIVO — falha de negócio na validação mostra o erro de ação TRADUZIDO POR CÓDIGO, sem quebrar a tela', async () => {
    // D3 (revisão de conformidade, 15/09): antes a tela mostrava `err.message` cru — que na
    // integração real é o CODE vindo do backend (ex. "JA_VALIDADO"), texto ilegível. Agora
    // `describeError` traduz por `error.byCode.<CODE>`, com o texto genérico da ação como
    // fallback do i18n — o mock de `t` (topo do arquivo) devolve esse fallback como STRING.
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockResolvedValue(makeSnapshot().patients[0]),
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: makeSnapshot().updatedAt, stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn().mockRejectedValue(new AnaCareHoursServiceError('JA_VALIDADO', 'já validado, não pode reabrir')),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'));
    await waitFor(() =>
      expect(screen.getByTestId('anacare-hours-action-error')).toHaveTextContent('admin.anacareHours.error.validateShift'),
    );
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
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'));
    await waitFor(() => expect(screen.getByTestId('anacare-hours-action-error')).toHaveTextContent('admin.anacareHours.error.validateShift'));
  });

  it('POSITIVO — validar em lote chama service.validateBatch', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const spy = vi.spyOn(service, 'validateBatch');
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ shiftIds: ['s1'] }));
  });

  it('NEGATIVO — falha de negócio ao validar em LOTE mostra o erro de ação traduzido por código', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockResolvedValue(makeSnapshot().patients[0]),
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: makeSnapshot().updatedAt, stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn(),
      validateBatch: vi.fn().mockRejectedValue(new AnaCareHoursServiceError('RETRATO_DESATUALIZADO', 'retrato velho')),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    await waitFor(() =>
      expect(screen.getByTestId('anacare-hours-action-error')).toHaveTextContent('admin.anacareHours.error.validateBatch'),
    );
  });

  it('POSITIVO — contestar chama service.contestShift com reason e note trimados', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const spy = vi.spyOn(service, 'contestShift');
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
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
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="no-existe" onBack={vi.fn()} />);
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
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-detail-error')).toHaveTextContent('admin.anacareHours.error.sourceNotConfigured'));
  });

  it('POSITIVO — "Volver" chama onBack', async () => {
    comEnforcement([], 'off');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const onBack = vi.fn();
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={onBack} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-back')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-back'));
    expect(onBack).toHaveBeenCalled();
  });

  // D5 (cobertura 100%, revisão de conformidade 15/09) — os 3 testes abaixo fecham os ramos que
  // faltavam: loading (89), falha de negócio em CONTESTAR (83-84, irmã da validação já coberta) e
  // snapshot ausente sem erro/loading (108) — ocorre quando `getRetratoStatus` resolve algo sem
  // forma (ex. backend com contrato quebrado), não só em "mês sem paciente".

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
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-detail-loading')).toBeInTheDocument();
    resolvePatient(null); // libera a promise pendente — evita vazar estado pro próximo teste
  });

  it('NEGATIVO — falha de negócio ao CONTESTAR mostra o erro de ação traduzido por código', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(),
      getPatientMonth: vi.fn().mockResolvedValue(makeSnapshot().patients[0]),
      getRetratoStatus: vi.fn().mockResolvedValue({ updatedAt: makeSnapshot().updatedAt, stale: false, circuitBreakerOpen: false }),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn().mockRejectedValue(new AnaCareHoursServiceError('MOTIVO_INVALIDO', 'motivo inválido')),
    };
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
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
    const { container } = render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-detail-loading')).not.toBeInTheDocument());
    expect(screen.queryByTestId('anacare-hours-detail-error')).not.toBeInTheDocument();
    expect(container.textContent).toBe('');
  });

  // Conserto de conformidade (15/09) — cobertura 100%: as duas guardas de corrida
  // (`handleValidateBatch`/`handleContestShift`) e o ramo de erro genérico do load (linha 101,
  // `error` cru quando NÃO é `FONTE_NAO_CONFIGURADA`). A guarda de `handleValidateShift` (linha
  // 55) foi REMOVIDA por ser ramo morto — ver comentário no componente.

  it('🔴 guarda de corrida — lote: gate vira negado com o modal JÁ ABERTO, confirmar não chama o service', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const spy = vi.spyOn(service, 'validateBatch');
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    expect(screen.getByTestId('anacare-hours-batch-modal-confirm')).toBeInTheDocument();

    // O modal já está aberto (botão "Confirmar" não é regatead pelo `disableActions`) — o gate
    // vira negado DEPOIS, como um refetch de authz que revoga a permissão em outra aba.
    act(() => comEnforcement(['anacare_hours:read'], 'on'));

    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('🔴 guarda de corrida — contestar: gate vira negado com o modal JÁ ABERTO, confirmar não chama o service', async () => {
    comEnforcement(['anacare_hours:read', 'anacare_hours:validate'], 'on');
    const service = new FakeAnaCareHoursService({ '2026-08': makeSnapshot() });
    const spy = vi.spyOn(service, 'contestShift');
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-contest-shift-s1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('anacare-hours-contest-shift-s1'));
    fireEvent.change(screen.getByTestId('anacare-hours-contest-reason'), { target: { value: 'otro' } });
    expect(screen.getByTestId('anacare-hours-contest-confirm')).toBeInTheDocument();

    act(() => comEnforcement(['anacare_hours:read'], 'on'));

    fireEvent.click(screen.getByTestId('anacare-hours-contest-confirm'));
    expect(spy).not.toHaveBeenCalled();
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
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByTestId('anacare-hours-detail-error')).toHaveTextContent('No se pudo cargar el paciente.'),
    );
  });

  // Tarefa 2 (16/09): mês buscado de UMA vez, semana navegada EM MEMÓRIA — navegar de semana NÃO
  // pode disparar fetch novo (o mês inteiro já veio na montagem); só "Actualizar" refaz a busca.
  it('POSITIVO — navegação de semana NÃO dispara fetch novo; "Actualizar" refaz exatamente 1 chamada', async () => {
    comEnforcement([], 'off');
    const snap = makeSnapshot();
    // Segundo turno numa semana seguinte à do primeiro (14/08 é sexta; semana seguinte começa 17/08).
    snap.patients[0].providers[0].shifts.push({
      id: 's2',
      date: '2026-08-20',
      scheduledStart: '08:00',
      scheduledEnd: '16:00',
      actualStart: '08:00',
      actualEnd: '16:00',
      hoursActual: 8,
      hoursScheduled: 8,
      origin: 'app',
      status: 'pendiente',
      anaCareShiftId: '2',
    });
    const service = new FakeAnaCareHoursService({ '2026-08': snap });
    const spy = vi.spyOn(service, 'getPatientMonth');
    render(<AnaCareHoursDetailContainer axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} service={service} month="2026-08" patientId="90000" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-shift-row-s1')).toBeInTheDocument());
    expect(spy).toHaveBeenCalledTimes(1);

    // Navegar pra semana seguinte troca o que aparece na tela (s1 some, s2 aparece) SEM buscar de novo.
    fireEvent.click(screen.getByTestId('anacare-hours-week-next'));
    await waitFor(() => expect(screen.getByTestId('anacare-hours-shift-row-s2')).toBeInTheDocument());
    expect(screen.queryByTestId('anacare-hours-shift-row-s1')).not.toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(1);

    // "Actualizar" refaz a MESMA (única) chamada do mês.
    fireEvent.click(screen.getByTestId('anacare-hours-refresh'));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
