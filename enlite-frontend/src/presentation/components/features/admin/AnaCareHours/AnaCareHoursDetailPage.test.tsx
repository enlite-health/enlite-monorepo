import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AnaCareHoursDetailPage } from './AnaCareHoursDetailPage';
import type { AnaCareHoursPatientSnapshot } from './types';
import type { AxonicoComprobanteService } from './AxonicoComprobanteService';
import type { AnaCarePatientDocumentService } from './AnaCarePatientDocumentService';

/** Fake mínimo — nenhum teste deste arquivo exercita o clique em "Enviar" (isso é `DayGroup.test.tsx`/`AxonicoSendControl` via `DayGroup`); só precisa satisfazer a prop obrigatória. */
const AXONICO_SERVICE: AxonicoComprobanteService = { enviarComprobante: vi.fn() };
const PATIENT_DOCUMENT_SERVICE: AnaCarePatientDocumentService = { registerDocument: vi.fn() };

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

function snapshot(overrides: Partial<AnaCareHoursPatientSnapshot> = {}): AnaCareHoursPatientSnapshot {
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
    ...overrides,
  };
}

/** Promise controlável de fora — usado pra inspecionar o estado "em voo" (`Validando…`) antes de resolver/rejeitar. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AnaCareHoursDetailPage', () => {
  // Regra nova (18/09): a semana inicial depende de "hoje" × mês exibido (`snapshot.month`).
  // Todo o resto do arquivo assume a semana de 10-16/08 (onde cai o único turno do fixture,
  // 2026-08-14) — por isso o relógio fica congelado NESSE dia: com "hoje" = 14/08 e o mês do
  // snapshot = '2026-08' (o mesmo mês), a regra nova cai na semana de hoje, que é a mesma semana
  // que o comportamento antigo (turno mais antigo) produzia. Os 2 testes da regra nova congelam
  // outro relógio, isoladamente, quando precisam de outro cenário.
  beforeEach(() => {
    // `shouldAdvanceTime: true` (26/09, mesmo padrão de `AnaCareHoursDetailContainer.test.tsx`):
    // sem isso, o polling do `waitFor` (setTimeout real) nunca dispara com o relógio fake parado —
    // os testes novos de "Validando…" (que esperam uma promise controlada assentar) travavam em
    // timeout de 5s. `shouldAdvanceTime` deixa o relógio fake avançar no ritmo real, sem soltar o
    // congelamento de data que a navegação de semana (comentário acima) precisa.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-14T12:00:00-03:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('NEGATIVO — paciente inexistente no snapshot mostra "patientNotFound"', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="no-existe" onBack={vi.fn()} />);
    expect(screen.getByText(/detail\.patientNotFound/)).toBeInTheDocument();
  });

  it('POSITIVO — voltar chama onBack', () => {
    const onBack = vi.fn();
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={onBack} />);
    fireEvent.click(screen.getByTestId('anacare-hours-back'));
    expect(onBack).toHaveBeenCalled();
  });

  it('1.5a (D344) — POSITIVO: sem `blockReasonMode` explícito, o motivo por prestador nasce CURTO ("retrato desactualizado"), nunca o texto longo', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot({ stale: true })} patientId="90000" onBack={vi.fn()} />);
    // motivo por prestador: texto curto (sem a palavra "horas", que só existe na frase longa)
    const providerReason = screen.getByTestId('anacare-hours-disable-reason-day-2026-08-14');
    expect(providerReason).toHaveTextContent('admin.anacareHours.stale.blockedPrefix');
    expect(providerReason.textContent).not.toMatch(/deshabilitada hasta actualizar/);
  });

  it('1.5a (D344) — POSITIVO: o banner do topo continua com o texto LONGO, mesmo com o padrão curto por prestador', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot({ stale: true })} patientId="90000" onBack={vi.fn()} />);
    expect(screen.getByText(/deshabilitada hasta actualizar/)).toBeInTheDocument();
  });

  it('1.5a (D344) — POSITIVO: `blockReasonMode="largo"` explícito ainda funciona (função pura preservada)', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot({ stale: true })} patientId="90000" onBack={vi.fn()} blockReasonMode="largo" />);
    const providerReason = screen.getByTestId('anacare-hours-disable-reason-day-2026-08-14');
    expect(providerReason.textContent).toMatch(/deshabilitada hasta actualizar/);
  });

  /**
   * Item 3 (conserto, 17/09): "nunca construído" tem mensagem PRÓPRIA no detalhe — antes,
   * `getRetratoStatus` só carregava `stale`, e o hook aproximava para `'velho'`, fazendo o
   * detalhe afirmar "mais de 24 horas" quando a sincronização nunca rodou. Este teste MORRE se
   * alguém colapsar os estados de novo.
   */
  it('POSITIVO — retrato NUNCA construído (snapshotState=nao_construido) mostra mensagem própria, NÃO "mais de 24 horas"', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot({ stale: true, snapshotState: 'nao_construido' })} patientId="90000" onBack={vi.fn()} />);
    expect(screen.getByText(/admin\.anacareHours\.stale\.titleNaoConstruido/)).toBeInTheDocument();
    expect(screen.getByText('admin.anacareHours.stale.messageNaoConstruido')).toBeInTheDocument();
    expect(screen.queryByText(/^admin\.anacareHours\.stale\.title:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/deshabilitada hasta actualizar/)).not.toBeInTheDocument();
  });

  // F2 (change `anacare-horas-conclusao-de-corrida`, migration 457) — 2 estados novos.
  /**
   * `desconhecido` NÃO seta `stale=true` (compat: `nao_construido || velho`) nem
   * `circuitBreakerOpen` — a PROVA de que o banner do detalhe (antes gated só por `staleDisable`)
   * tem de nascer de `snapshotState` também: com `stale: false` aqui, o banner ANTIGO nunca
   * apareceria.
   */
  it('POSITIVO — snapshotState=desconhecido (stale=false) mostra o banner com mensagem própria, NUNCA "mais de 24 horas"', () => {
    render(
      <AnaCareHoursDetailPage
        axonicoService={AXONICO_SERVICE}
        patientDocumentService={PATIENT_DOCUMENT_SERVICE}
        snapshot={snapshot({ stale: false, snapshotState: 'desconhecido' })}
        patientId="90000"
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/^admin\.anacareHours\.stale\.titleDesconhecido/)).toBeInTheDocument();
    expect(screen.getByText('admin.anacareHours.stale.messageDesconhecido')).toBeInTheDocument();
    expect(screen.queryByText(/deshabilitada hasta actualizar/)).not.toBeInTheDocument();
  });

  // 🔴 Não-objetivo (proposal.md): `parcial`/`desconhecido` são informativos — NÃO desabilitam ações.
  it('desconhecido NÃO desabilita as ações (não-objetivo: esta change não decide a reação)', () => {
    render(
      <AnaCareHoursDetailPage
        axonicoService={AXONICO_SERVICE}
        patientDocumentService={PATIENT_DOCUMENT_SERVICE}
        snapshot={snapshot({ stale: false, snapshotState: 'desconhecido' })}
        patientId="90000"
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByTestId('anacare-hours-validate-shift-s1')).not.toBeDisabled();
  });

  it('POSITIVO — snapshotState=parcial SEM contagens mostra a mensagem curta (sem números)', () => {
    render(
      <AnaCareHoursDetailPage
        axonicoService={AXONICO_SERVICE}
        patientDocumentService={PATIENT_DOCUMENT_SERVICE}
        snapshot={snapshot({ stale: false, snapshotState: 'parcial' })}
        patientId="90000"
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText(/^admin\.anacareHours\.stale\.titleParcial/)).toBeInTheDocument();
    expect(screen.getByText('admin.anacareHours.stale.messageParcial')).toBeInTheDocument();
  });

  /**
   * CONTROLE POSITIVO (Decisão 9/design.md §F2) na tela de DETALHE: 49 de 144 reservas processadas
   * tem de aparecer interpolado — sabotar o estado e a tela deixar de estar muda é a prova.
   */
  it('CONTROLE POSITIVO — snapshotState=parcial COM contagens (49/144) mostra "processadas 49 de 144" interpolado', () => {
    render(
      <AnaCareHoursDetailPage
        axonicoService={AXONICO_SERVICE}
        patientDocumentService={PATIENT_DOCUMENT_SERVICE}
        snapshot={snapshot({ stale: false, snapshotState: 'parcial', reservationsTotal: 144, reservationsDone: 49 })}
        patientId="90000"
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText('admin.anacareHours.stale.messageParcialComContagem|{"done":49,"total":144}')).toBeInTheDocument();
    expect(screen.queryByText('admin.anacareHours.stale.messageParcial')).not.toBeInTheDocument();
  });

  it('NEGATIVO — snapshotState=fresco (stale=false, sem contagens) NÃO mostra banner nenhum', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    expect(screen.queryByText('admin.anacareHours.stale.titleParcial')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.anacareHours.stale.titleDesconhecido')).not.toBeInTheDocument();
    expect(screen.queryByText('admin.anacareHours.stale.title')).not.toBeInTheDocument();
  });

  it('POSITIVO — disableActionsReason (célula ausente) desabilita ações mesmo com retrato em dia, SEM mostrar o AlertBanner de retrato', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} disableActionsReason="Sem permissão" />);
    expect(screen.getByTestId('anacare-hours-validate-shift-s1')).toBeDisabled();
    expect(screen.queryByText('admin.anacareHours.stale.title')).not.toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-disable-reason-day-2026-08-14')).toHaveTextContent('Sem permissão');
  });

  it('POSITIVO — selecionar um turno mostra a barra fixa; "Limpiar selección" some com ela', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    expect(screen.queryByTestId('anacare-hours-selection-bar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    expect(screen.getByTestId('anacare-hours-selection-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anacare-hours-selection-clear'));
    expect(screen.queryByTestId('anacare-hours-selection-bar')).not.toBeInTheDocument();
  });

  it('POSITIVO — clicar no MESMO checkbox duas vezes seleciona e depois desmarca (toggle)', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    const checkbox = screen.getByTestId('anacare-hours-select-shift-s1');
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByTestId('anacare-hours-selection-bar')).not.toBeInTheDocument();
  });

  it('POSITIVO — validar em lote: abre o modal, confirmar chama onValidateBatch e limpa a seleção', async () => {
    const onValidateBatch = vi.fn();
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onValidateBatch={onValidateBatch} />);
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    expect(screen.getByTestId('anacare-hours-batch-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    expect(onValidateBatch).toHaveBeenCalledWith(['s1']);
    // change `anacare-horas-validando-prd` (26/09): o fecho do modal + limpeza da seleção agora
    // esperam a promise de `onValidateBatch` assentar (antes era síncrono) — é o que abre espaço
    // pro "Validando…" aparecer enquanto ela está em voo (ver testes novos abaixo).
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-batch-modal')).not.toBeInTheDocument());
    expect(screen.queryByTestId('anacare-hours-selection-bar')).not.toBeInTheDocument();
  });

  it('POSITIVO — validar em lote: enquanto a promise está pendente, "Confirmar" mostra "Validando…"/disabled/aria-busy; ao resolver fecha o modal e limpa a seleção', async () => {
    const { promise, resolve } = deferred();
    const onValidateBatch = vi.fn(() => promise);
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onValidateBatch={onValidateBatch} />);
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    const confirmBtn = screen.getByTestId('anacare-hours-batch-modal-confirm');
    fireEvent.click(confirmBtn);
    expect(onValidateBatch).toHaveBeenCalledWith(['s1']);
    expect(confirmBtn).toHaveTextContent('admin.anacareHours.batchModal.validating');
    expect(confirmBtn).toBeDisabled();
    expect(confirmBtn).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('anacare-hours-batch-modal')).toBeInTheDocument();
    resolve();
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-batch-modal')).not.toBeInTheDocument());
    expect(screen.queryByTestId('anacare-hours-selection-bar')).not.toBeInTheDocument();
  });

  it('NEGATIVO — validar em lote: promise rejeitada também fecha o modal ao final (erro fica por conta de quem chama, já tratado no container)', async () => {
    const onValidateBatch = vi.fn().mockRejectedValue(new Error('boom'));
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onValidateBatch={onValidateBatch} />);
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-confirm'));
    await waitFor(() => expect(screen.queryByTestId('anacare-hours-batch-modal')).not.toBeInTheDocument());
    expect(screen.queryByTestId('anacare-hours-selection-bar')).not.toBeInTheDocument();
  });

  it('POSITIVO — cancelar o modal de lote fecha sem chamar onValidateBatch', () => {
    const onValidateBatch = vi.fn();
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onValidateBatch={onValidateBatch} />);
    fireEvent.click(screen.getByTestId('anacare-hours-select-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-selection-validate'));
    fireEvent.click(screen.getByTestId('anacare-hours-batch-modal-cancel'));
    expect(screen.queryByTestId('anacare-hours-batch-modal')).not.toBeInTheDocument();
    expect(onValidateBatch).not.toHaveBeenCalled();
  });

  it('POSITIVO — validar um turno chama onValidateShift', async () => {
    const onValidateShift = vi.fn();
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onValidateShift={onValidateShift} />);
    fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'));
    expect(onValidateShift).toHaveBeenCalled();
    // change `anacare-horas-validando-prd` (26/09): `handleValidateShift` agora é async (rastreia
    // `validatingShiftIds`) mesmo com um mock síncrono — sem esperar o `finally` assentar, o
    // `act()` do RTL acusa "update not wrapped" (o setState do finally ainda não rodou).
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).not.toBeDisabled());
  });

  it('POSITIVO — validar turno: enquanto a promise está pendente, o botão mostra "Validando…"/disabled/aria-busy; ao resolver, volta ao normal', async () => {
    const { promise, resolve } = deferred();
    const onValidateShift = vi.fn(() => promise);
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onValidateShift={onValidateShift} />);
    const button = screen.getByTestId('anacare-hours-validate-shift-s1');
    fireEvent.click(button);
    expect(button).toHaveTextContent('admin.anacareHours.providerGroup.validating');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    resolve();
    await waitFor(() => expect(button).toHaveTextContent('admin.anacareHours.providerGroup.validateAction'));
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
  });

  it('NEGATIVO — validar turno: promise rejeitada também volta ao normal (erro fica por conta de quem chama, já tratado no container)', async () => {
    const onValidateShift = vi.fn().mockRejectedValue(new Error('boom'));
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onValidateShift={onValidateShift} />);
    const button = screen.getByTestId('anacare-hours-validate-shift-s1');
    fireEvent.click(button);
    expect(button).toBeDisabled();
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveTextContent('admin.anacareHours.providerGroup.validateAction');
  });

  it('POSITIVO — contestar abre o modal e confirmar chama onContestShift(shiftId, reason, note)', () => {
    const onContestShift = vi.fn();
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onContestShift={onContestShift} />);
    fireEvent.click(screen.getByTestId('anacare-hours-contest-shift-s1'));
    expect(screen.getByTestId('anacare-hours-contest-modal')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('anacare-hours-contest-reason'), { target: { value: 'otro' } });
    fireEvent.click(screen.getByTestId('anacare-hours-contest-confirm'));
    expect(onContestShift).toHaveBeenCalledWith('s1', 'otro', '');
    expect(screen.queryByTestId('anacare-hours-contest-modal')).not.toBeInTheDocument();
  });

  it('POSITIVO — cancelar o modal de contestação fecha sem chamar onContestShift', () => {
    const onContestShift = vi.fn();
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} onContestShift={onContestShift} />);
    fireEvent.click(screen.getByTestId('anacare-hours-contest-shift-s1'));
    fireEvent.click(screen.getByTestId('anacare-hours-contest-cancel'));
    expect(screen.queryByTestId('anacare-hours-contest-modal')).not.toBeInTheDocument();
    expect(onContestShift).not.toHaveBeenCalled();
  });

  it('POSITIVO — checkbox de cabeçalho do DIA marca todos os pendentes (de prestadores diferentes); clicar de novo desmarca', () => {
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
              ],
            },
            {
              anaCareId: 'p2',
              linked: true,
              name: 'Marta Sosa QA',
              shifts: [
                { id: 's2', date: '2026-08-14', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'app', status: 'pendiente', anaCareShiftId: '2' },
              ],
            },
          ],
        },
      ],
    });
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snap} patientId="90000" onBack={vi.fn()} />);
    const headerCheckbox = screen.getByTestId('anacare-hours-select-all-pending-day-2026-08-14');
    fireEvent.click(headerCheckbox); // marca todos (state 'none' -> marca)
    expect(screen.getByTestId('anacare-hours-select-shift-s1')).toBeChecked();
    expect(screen.getByTestId('anacare-hours-select-shift-s2')).toBeChecked();
    fireEvent.click(headerCheckbox); // já 'all' -> desmarca todos
    expect(screen.getByTestId('anacare-hours-select-shift-s1')).not.toBeChecked();
    expect(screen.getByTestId('anacare-hours-select-shift-s2')).not.toBeChecked();
  });

  it('POSITIVO — sem callbacks de escrita, os cliques não quebram (no-op)', async () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    expect(() => fireEvent.click(screen.getByTestId('anacare-hours-validate-shift-s1'))).not.toThrow();
    await waitFor(() => expect(screen.getByTestId('anacare-hours-validate-shift-s1')).not.toBeDisabled());
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
                { id: 'x3', date: '2026-08-03', scheduledStart: '08:00', scheduledEnd: '16:00', actualStart: '08:00', actualEnd: '16:00', hoursActual: 8, hoursScheduled: 8, origin: 'app', status: 'validado', validatedBy: { id: 'e2e-qa', name: 'Y' }, validatedAt: '2026-08-04T00:00:00Z', anaCareShiftId: '3' },
              ],
            },
          ],
        },
      ],
    });
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snap} patientId="90000" onBack={vi.fn()} />);
    expect(screen.getByText(/detail\.validationContestedSuffix/)).toBeInTheDocument();
    expect(screen.getAllByText('admin.anacareHours.origin.sinCheckin').length).toBeGreaterThan(0);
    expect(screen.getAllByText('admin.anacareHours.origin.webAdmin').length).toBeGreaterThan(0);
  });

  it('POSITIVO — pílulas de origem só aparecem quando a contagem é > 0', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    // só 'app' está presente no fixture — sin_checkin/web_admin não devem renderizar pílula.
    expect(screen.getAllByText('admin.anacareHours.origin.app').length).toBeGreaterThan(0);
  });

  it('NEGATIVO — apagar a data no seletor (`onChange` com valor vazio) NÃO navega — o operador não cai numa semana em branco por engano', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    const labelBefore = screen.getByTestId('anacare-hours-week-label').textContent;
    fireEvent.change(screen.getByTestId('anacare-hours-week-datepicker'), { target: { value: '' } });
    expect(screen.getByTestId('anacare-hours-week-label').textContent).toBe(labelBefore);
    // o caminho de valor PREENCHIDO continua navegando de verdade (contraste — não é só ausência de crash).
    fireEvent.change(screen.getByTestId('anacare-hours-week-datepicker'), { target: { value: '2026-09-01' } });
    expect(screen.getByTestId('anacare-hours-week-label').textContent).not.toBe(labelBefore);
  });

  /**
   * Item 3 (revisão de PR): semana sem NENHUM turno nunca foi vista em teste — o paciente real que
   * gerou esse achado tem turno numa semana e nada na seguinte. O operador precisa ver "sem
   * turnos", não uma tela em branco sem explicação.
   */
  it('POSITIVO — navegar para uma semana sem NENHUM turno mostra "weekEmpty" ao operador (nunca tela em branco)', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    expect(screen.queryByTestId('anacare-hours-week-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-day-group-2026-08-14')).toBeInTheDocument();
    // único turno do fixture é 2026-08-14 (semana de 10 a 16/08) — a semana seguinte não tem nada.
    fireEvent.click(screen.getByTestId('anacare-hours-week-next'));
    expect(screen.queryByTestId('anacare-hours-day-group-2026-08-14')).not.toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-week-empty')).toHaveTextContent('admin.anacareHours.detail.weekEmpty');
  });

  it('POSITIVO — "semana anterior" navega pra trás (o dia com turno some quando a semana muda)', () => {
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot()} patientId="90000" onBack={vi.fn()} />);
    expect(screen.getByTestId('anacare-hours-day-group-2026-08-14')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anacare-hours-week-prev'));
    expect(screen.queryByTestId('anacare-hours-day-group-2026-08-14')).not.toBeInTheDocument();
    expect(screen.getByTestId('anacare-hours-week-empty')).toBeInTheDocument();
    // voltar pra frente traz o dia de volta — prova que "prev" moveu a janela, não zerou o estado.
    fireEvent.click(screen.getByTestId('anacare-hours-week-next'));
    expect(screen.getByTestId('anacare-hours-day-group-2026-08-14')).toBeInTheDocument();
  });

  it('18/09 — POSITIVO: mês exibido CONTÉM hoje → semana inicial é a semana de hoje', () => {
    vi.setSystemTime(new Date('2026-09-18T12:00:00-03:00')); // sexta-feira
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot({ month: '2026-09' })} patientId="90000" onBack={vi.fn()} />);
    // segunda da semana de 18/09 é 14/09 — não é o turno mais antigo do paciente (que é 14/08).
    expect(screen.getByTestId('anacare-hours-week-datepicker')).toHaveValue('2026-09-14');
  });

  it('18/09 — POSITIVO: mês exibido NÃO contém hoje → semana inicial é a PRIMEIRA semana do mês', () => {
    vi.setSystemTime(new Date('2026-09-18T12:00:00-03:00')); // hoje é setembro, mês exibido é agosto
    render(<AnaCareHoursDetailPage axonicoService={AXONICO_SERVICE} patientDocumentService={PATIENT_DOCUMENT_SERVICE} snapshot={snapshot({ month: '2026-08' })} patientId="90000" onBack={vi.fn()} />);
    // segunda da semana que contém 01/08 é 27/07 — não é a semana do turno mais antigo (10-16/08).
    expect(screen.getByTestId('anacare-hours-week-datepicker')).toHaveValue('2026-07-27');
  });
});
