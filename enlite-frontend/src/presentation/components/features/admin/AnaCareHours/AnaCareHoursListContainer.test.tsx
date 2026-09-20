import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { AnaCareHoursListContainer } from './AnaCareHoursListContainer';
import { AnaCareHoursServiceError, FakeAnaCareHoursService } from './AnaCareHoursService';
import type { AnaCareHoursService } from './AnaCareHoursService';
import type { AnaCareMonthSnapshot, TriggerSyncResult } from './types';

// `i18n.language` (não só `t`): `AnaCareHoursListPage` (renderizada por baixo) usa `i18n.language`
// pra formatar o rótulo do mês (`formatMonthLabel`) desde a troca do seletor de mês fixo pra
// `monthOptionsUntilNow` (decisão do Gabriel, 20/09) — mock sem isso quebra com "Cannot read
// properties of undefined (reading 'language')".
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'es' } }) }));

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
        snapshotState: 'fresco',
        circuitBreakerOpen: false,
        patients: [{ anaCareId: '90000', linked: true, name: 'Lucía Fernández QA', providers: [] }],
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

  // D7 (cobertura, 18/09): `sync={service.triggerSync ? sync : undefined}` (linha 72) — os testes
  // acima usam FakeAnaCareHoursService, que NÃO implementa `triggerSync` (cobre o ramo `undefined`,
  // botão ausente). Este teste cobre o ramo TRUE: serviço COM `triggerSync` passa o hook adiante e
  // o botão "Sincronizar" aparece na lista.
  it('POSITIVO — serviço com triggerSync: o botão "Sincronizar" aparece na lista', async () => {
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn().mockResolvedValue({
        month: '2026-08',
        updatedAt: '2026-09-15T08:00:00-03:00',
        stale: false,
        snapshotState: 'fresco',
        circuitBreakerOpen: false,
        patients: [],
      }),
      getPatientMonth: vi.fn(),
      getRetratoStatus: vi.fn(),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
      triggerSync: vi.fn(),
    };
    render(<AnaCareHoursListContainer service={service} onOpenPatient={vi.fn()} initialMonth="2026-08" />);
    await waitFor(() => expect(screen.getByTestId('anacare-hours-sync-button')).toBeInTheDocument());
  });

  // Decisão do Gabriel, 20/09/2026: o mês padrão da tela virou o mês CORRENTE (antes era o mês
  // ANTERIOR). Este teste MORRE se alguém reintroduzir `previousMonthIso`/mês fixo como default —
  // o esperado é calculado em runtime (nunca `'2026-09'` cravado), senão o teste apodrece sozinho
  // assim que rodar num mês diferente. Régua tem de ser a MESMA do código sob teste: relógio LOCAL
  // (`getFullYear`/`getMonth`, como `currentMonthIso` em `selectors.ts`), NUNCA `getUTC*` — com
  // UTC o teste passa sempre num runner UTC (CI) e falha em UTC-3 na virada do mês.
  it('POSITIVO — sem initialMonth, pede ao service o mês CORRENTE (calculado em runtime)', async () => {
    const now = new Date();
    const expectedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn().mockResolvedValue({
        month: expectedMonth,
        updatedAt: '2026-09-15T08:00:00-03:00',
        stale: false,
        snapshotState: 'fresco',
        circuitBreakerOpen: false,
        patients: [],
      }),
      getPatientMonth: vi.fn(),
      getRetratoStatus: vi.fn(),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
    };
    render(<AnaCareHoursListContainer service={service} onOpenPatient={vi.fn()} />);
    await waitFor(() => expect(service.getMonthSnapshot).toHaveBeenCalledWith(expectedMonth, undefined));
  });
});

// Composição container + page + hooks — a camada que faltava (ver fix/anacare-horas-mes-exibido-x-enviado):
// nenhum teste unitário isolado (page/hook) compõe "trocar o seletor → clicar em sincronizar", que
// é onde o mês EXIBIDO e o mês ENVIADO podiam divergir (medido em produção: 1 POST em 30 dias, com
// agosto gravado enquanto o seletor já mostrava setembro).
describe('AnaCareHoursListContainer — mês EXIBIDO no seletor × mês ENVIADO ao sync', () => {
  const AGO = '2026-08';
  const SEP = '2026-09';

  function snap(month: string): AnaCareMonthSnapshot {
    return { month, updatedAt: '2026-09-20T04:00:00-03:00', stale: false, snapshotState: 'fresco', circuitBreakerOpen: false, patients: [] };
  }

  function syncResult(overrides: Partial<TriggerSyncResult> = {}): TriggerSyncResult {
    return {
      success: true,
      deduped: false,
      shiftsRead: 10,
      reservationsProcessed: 10,
      shiftsWritten: 10,
      nextCursor: null,
      runStartedAt: '2026-09-20T07:16:27.981Z',
      shiftsSkippedNoProvider: 0,
      shiftsSkippedNoPatient: 0,
      ...overrides,
    };
  }

  /** Rig com `getMonthSnapshot`/`triggerSync` controláveis à mão (nenhum resolve sozinho) — mesmo padrão do artefato de caça que encontrou o bug, adaptado ao contrato real do `AnaCareHoursService`. */
  function makeControllableService() {
    const monthWaiters: Record<string, (s: AnaCareMonthSnapshot) => void> = {};
    const syncCalls: Array<{ month: string; cursor?: number | null }> = [];
    let syncResolve: ((r: TriggerSyncResult) => void) | null = null;
    const service: AnaCareHoursService = {
      getMonthSnapshot: vi.fn(
        (month: string) =>
          new Promise<AnaCareMonthSnapshot>((res) => {
            monthWaiters[month] = res;
          }),
      ),
      getPatientMonth: vi.fn(),
      getRetratoStatus: vi.fn(),
      validateShift: vi.fn(),
      validateBatch: vi.fn(),
      contestShift: vi.fn(),
      triggerSync: vi.fn((cmd) => {
        syncCalls.push({ month: cmd.month, cursor: cmd.cursor });
        return new Promise<TriggerSyncResult>((res) => {
          syncResolve = res;
        });
      }),
    };
    return {
      service,
      syncCalls,
      resolveMonth: (month: string) => monthWaiters[month]?.(snap(month)),
      resolveSync: (r: TriggerSyncResult) => syncResolve?.(r),
    };
  }

  const select = () => screen.getByLabelText('admin.anacareHours.monthAriaLabel') as HTMLSelectElement;
  const syncButton = () => screen.getByTestId('anacare-hours-sync-button');

  beforeEach(() => {
    sessionStorage.clear();
  });

  it('COMPOSIÇÃO — troca para o mês seguinte com o fetch em voo: o sync recebe o MESMO mês que o seletor exibe', async () => {
    const r = makeControllableService();
    render(<AnaCareHoursListContainer service={r.service} onOpenPatient={vi.fn()} initialMonth={AGO} />);
    await act(async () => r.resolveMonth(AGO));
    await waitFor(() => expect(select()).toBeInTheDocument());

    fireEvent.change(select(), { target: { value: SEP } });
    // NÃO resolve o snapshot de SEP — a janela de carregamento em que o bug vivia.
    expect(select().value).toBe(SEP);
    fireEvent.click(syncButton());

    expect(r.syncCalls.map((c) => c.month)).toEqual([SEP]);
  });

  it('COMPOSIÇÃO — sentido inverso: volta para o mês anterior com o fetch em voo, sync ainda recebe o mês exibido', async () => {
    const r = makeControllableService();
    render(<AnaCareHoursListContainer service={r.service} onOpenPatient={vi.fn()} initialMonth={AGO} />);
    await act(async () => r.resolveMonth(AGO));
    await waitFor(() => expect(select()).toBeInTheDocument());

    fireEvent.change(select(), { target: { value: SEP } });
    await act(async () => r.resolveMonth(SEP));
    await waitFor(() => expect(select().value).toBe(SEP));

    // Volta para AGO — o fetch de agosto fica em voo (refetch real leva centenas de ms).
    fireEvent.change(select(), { target: { value: AGO } });
    expect(select().value).toBe(AGO);
    fireEvent.click(syncButton());

    expect(r.syncCalls.map((c) => c.month)).toEqual([AGO]);
  });

  it('COMPOSIÇÃO — sincronizar e trocar de mês no meio da corrida: a tela avisa a interrupção e o cursor fica retomável', async () => {
    const r = makeControllableService();
    render(<AnaCareHoursListContainer service={r.service} onOpenPatient={vi.fn()} initialMonth={AGO} />);
    await act(async () => r.resolveMonth(AGO));
    await waitFor(() => expect(select()).toBeInTheDocument());

    fireEvent.click(syncButton());
    expect(r.syncCalls.map((c) => c.month)).toEqual([AGO]);
    expect(screen.getByTestId('anacare-hours-sync-progress')).toBeInTheDocument();

    // Troca de mês no MEIO da corrida de agosto (rodada 1 ainda em voo).
    fireEvent.change(select(), { target: { value: SEP } });

    await act(async () => r.resolveSync(syncResult({ nextCursor: 5, reservationsProcessed: 10 })));
    await act(async () => r.resolveMonth(SEP));

    // Nunca uma 2ª rodada de AGO disparada sozinha (a corrida velha não pode ficar viva).
    expect(r.syncCalls.map((c) => c.month)).toEqual([AGO]);
    // Sem silêncio: a tela sinaliza a interrupção.
    await waitFor(() => expect(screen.getByTestId('anacare-hours-sync-interrupted')).toBeInTheDocument());
    // E o cursor da rodada em voo foi persistido — retomável (mecanismo já existente em sessionStorage).
    expect(sessionStorage.getItem('anacare-hours-sync:2026-08')).toBe(JSON.stringify({ cursor: 5 }));
  });
});
