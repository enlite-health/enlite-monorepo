/**
 * usePatientKanban — o board passa a agrupar por `patients.status` (estado clínico v2), não mais
 * por `admissionStatus` (funil de admissão, migration 313). Colunas: ADMISSION (junta os 3 estados
 * do funil antigo: SOLICITANTE / ADMISSION / PENDING_ADMISSION) / SEARCHING / REPLACEMENT / ACTIVE
 * / ON_HOLD / SUSPENDED / ALTA / DISCHARGED. Mover para qualquer coluna chama `PUT /status` com
 * `changeSource: 'kanban'` — é a coluna "origem" do Historial. Exceção (spec 018, PR-6, ADR-5): a
 * migration 428 tira funil→ACTIVE do catálogo, então sair de ADMISSION direto para ACTIVE NÃO
 * chama a API — devolve `KANBAN_ACTIVATION_MOVED_TO_SERVICE` na hora, sem tocar o agrupamento.
 * Ativar virou uma ação por SERVIÇO (`ServicosContratadosCard`, "Activar reclutamiento").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const listPatientsForKanban = vi.fn();
const updatePatientStatus = vi.fn();
const getPatientStatusOptions = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listPatientsForKanban: (...a: unknown[]) => listPatientsForKanban(...a),
    updatePatientStatus: (...a: unknown[]) => updatePatientStatus(...a),
    getPatientStatusOptions: (...a: unknown[]) => getPatientStatusOptions(...a),
  },
}));

import { PatientApiError } from '@infrastructure/http/AdminPatientsApiService';
import {
  usePatientKanban,
  PATIENT_KANBAN_STATUSES,
  KANBAN_ACTIVATION_MOVED_TO_SERVICE,
  type PatientKanbanMoveError,
} from '../usePatientKanban';

const item = (id: string, admissionStatus: string, status: string) => ({
  id, firstName: 'P', lastName: id, caseNumber: null, dependencyLevel: null, status, admissionStatus, responsibleName: null,
});

describe('usePatientKanban — patients.status', () => {
  beforeEach(() => {
    listPatientsForKanban.mockReset().mockResolvedValue([
      item('a', 'SOLICITANTE', 'SOLICITANTE'),
      item('b', 'DONE', 'ON_HOLD'),        // status próprio → coluna ON_HOLD, não mais DONE
      item('c', 'DONE', 'ACTIVE'),
      item('d', 'PENDING_ADMISSION', 'PENDING_ADMISSION'),
      item('e', 'DONE', 'DISCHARGED'),     // alta definitiva → coluna DISCHARGED, nunca ACTIVE (1.6)
    ]);
    updatePatientStatus.mockReset().mockResolvedValue({ id: 'x', status: 'ACTIVE' });
    // A lista do SERVIDOR (spec 051): por padrão oferece todas as colunas, para os testes de PUT/rollback.
    getPatientStatusOptions.mockReset().mockResolvedValue({
      current: 'ACTIVE',
      options: PATIENT_KANBAN_STATUSES.map((status) => ({ status, via: 'fluxo' })),
    });
  });

  it('as colunas são os 8 estados clínicos, e o agrupamento é por status (ADMISSION junta o funil; DISCHARGED não cai em ACTIVE)', async () => {
    expect([...PATIENT_KANBAN_STATUSES]).toEqual([
      'ADMISSION', 'SEARCHING', 'REPLACEMENT', 'ACTIVE', 'ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED',
    ]);
    const { result } = renderHook(() => usePatientKanban('AR'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(listPatientsForKanban).toHaveBeenCalledWith('AR');
    expect(result.current.groups.ADMISSION.map((p) => p.id)).toEqual(['a', 'd']);
    expect(result.current.groups.ON_HOLD.map((p) => p.id)).toEqual(['b']);
    expect(result.current.groups.ACTIVE.map((p) => p.id)).toEqual(['c']);
    expect(result.current.groups.DISCHARGED.map((p) => p.id)).toEqual(['e']);
    expect(result.current.groups.SEARCHING).toEqual([]);
    expect(result.current.groups.REPLACEMENT).toEqual([]);
    expect(result.current.groups.SUSPENDED).toEqual([]);
    expect(result.current.groups.ALTA).toEqual([]);
  });

  // Spec 018, PR-6, ADR-5: a migration 428 tira funil→ACTIVE do catálogo. Soltar em ACTIVE quem
  // está em ADMISSION não chama mais `PUT /status` — o hook recusa ANTES da rede, sem tocar o
  // agrupamento (o card fica onde estava; não há otimismo a desfazer). Mover para outro estado
  // continua livre e chama a API com o próprio alvo.
  it('admisión → ACTIVE não chama a API — devolve KANBAN_ACTIVATION_MOVED_TO_SERVICE sem mexer no agrupamento; mover para outro estado chama updatePatientStatus normalmente', async () => {
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      expect(await result.current.moveStatus('d', 'ACTIVE')).toEqual({ code: KANBAN_ACTIVATION_MOVED_TO_SERVICE });
    });
    expect(updatePatientStatus).not.toHaveBeenCalled();
    // 'd' continua em ADMISSION — não mudou de coluna nenhuma.
    expect(result.current.groups.ADMISSION.map((p) => p.id)).toEqual(['a', 'd']);
    expect(result.current.groups.ACTIVE.map((p) => p.id)).toEqual(['c']);

    await act(async () => { await result.current.moveStatus('a', 'SEARCHING'); });
    expect(updatePatientStatus).toHaveBeenLastCalledWith('a', { status: 'SEARCHING', changeSource: 'kanban' });
  });

  it('falha no PUT restaura o agrupamento anterior e devolve a mensagem; card desconhecido não muda nada', async () => {
    updatePatientStatus.mockRejectedValueOnce(new Error('422 transição'));
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let err: PatientKanbanMoveError | null = null;
    await act(async () => { err = await result.current.moveStatus('a', 'ADMISSION'); });
    expect(err).toEqual({ code: '422 transição', missing: undefined, to: 'ADMISSION' });
    expect(result.current.groups.ADMISSION.map((p) => p.id)).toEqual(['a', 'd']);
    await act(async () => { err = await result.current.moveStatus('nao-existe', 'ADMISSION'); });
    expect(result.current.groups.ADMISSION.map((p) => p.id)).toEqual(['a', 'd']);
    updatePatientStatus.mockRejectedValueOnce('string-error');
    await act(async () => { err = await result.current.moveStatus('a', 'ADMISSION'); });
    expect(err).toEqual({ code: 'Failed to move patient', to: 'ADMISSION' });
  });

  // Spec 014 (US-D5, lex D5.1): quando o backend manda `code` (enum), o hook devolve o CÓDIGO,
  // nunca o texto cru — quem traduz para o toast é a página, com i18n (nunca eco de campo do
  // paciente). `code` vem de `PatientApiError` — a classe REAL usada pelo cliente HTTP.
  it('erro com `code` (PatientApiError real) → devolve o código, não a mensagem', async () => {
    class FakePatientApiError extends Error {
      readonly code?: string;
      constructor(message: string, code?: string) {
        super(message);
        this.code = code;
      }
    }
    updatePatientStatus.mockRejectedValueOnce(
      new FakePatientApiError('No se puede activar el paciente Juan Pérez', 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED'),
    );
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let err: PatientKanbanMoveError | null = null;
    await act(async () => { err = await result.current.moveStatus('a', 'ADMISSION'); });
    expect(err).toMatchObject({ code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED' });
    // nunca o texto com o nome do paciente — nem em `code`, nem em `missing`
    expect(JSON.stringify(err)).not.toContain('Juan Pérez');
  });

  // Decisão do Gabriel 07/09: o 422 de completude carrega `details.missing`, e o hook o leva
  // adiante para o toast poder NOMEAR o que falta em vez de dizer só "não foi possível mover".
  it('422 de completude → devolve o código E os códigos que faltam, sem eco de dado do paciente', async () => {
    class FakePatientApiError extends Error {
      readonly code?: string;
      readonly details?: unknown;
      constructor(message: string, code: string, details: unknown) {
        super(message);
        this.code = code;
        this.details = details;
      }
    }
    updatePatientStatus.mockRejectedValueOnce(
      new FakePatientApiError(
        'Patient not ready for status ACTIVE: falta SERVICE_SCHEDULE (paciente Juan Pérez)',
        'PATIENT_STATUS_NOT_READY',
        { to: 'ACTIVE', missing: ['ADDRESS', 'SERVICE_SCHEDULE'] },
      ),
    );
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let err: PatientKanbanMoveError | null = null;
    await act(async () => { err = await result.current.moveStatus('a', 'ADMISSION'); });

    expect(err).toEqual({
      code: 'PATIENT_STATUS_NOT_READY',
      missing: ['ADDRESS', 'SERVICE_SCHEDULE'],
      to: 'ADMISSION',
    });
    expect(JSON.stringify(err)).not.toContain('Juan Pérez');
    // o card volta para a coluna de origem (rollback otimista)
    expect(result.current.groups.ADMISSION.map((p) => p.id)).toEqual(['a', 'd']);
  });

  it('`details.missing` que não é array é ignorado — nunca vaza um objeto arbitrário do servidor', async () => {
    class FakeErr extends Error {
      readonly code = 'PATIENT_STATUS_NOT_READY';
      readonly details = { missing: { nome: 'Juan Pérez' } };
    }
    updatePatientStatus.mockRejectedValueOnce(new FakeErr('x'));
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let err: PatientKanbanMoveError | null = null;
    await act(async () => { err = await result.current.moveStatus('a', 'ADMISSION'); });

    expect(err).toEqual({ code: 'PATIENT_STATUS_NOT_READY', missing: undefined, to: 'ADMISSION' });
    expect(JSON.stringify(err)).not.toContain('Juan Pérez');
  });

  it('erro ao carregar vira `error`; refetch recarrega; fetch concorrente é ignorado', async () => {
    listPatientsForKanban.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce('x');
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.error).toBe('boom'));
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe('Failed to load patients');
  });

  it('refetch concorrente é ignorado (a 2ª chamada volta antes de bater na API)', async () => {
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    listPatientsForKanban.mockClear();
    await act(async () => { void result.current.refetch(); await result.current.refetch(); });
    expect(listPatientsForKanban).toHaveBeenCalledTimes(1);
  });

  // `columnOf` (usePatientKanban.ts:55) descarta quem não é nem um dos 8 status do board nem um
  // dos 3 do funil de admissão — o card não pode ficar preso "em algum lugar" fora dessas colunas.
  it('status fora das 8 colunas (ex.: DISCONTINUED legado) ou nulo é descartado — não aparece em nenhuma coluna', async () => {
    listPatientsForKanban.mockReset().mockResolvedValueOnce([
      item('a', 'SOLICITANTE', 'SOLICITANTE'),
      item('f', 'DONE', 'DISCONTINUED'),
      { ...item('g', 'DONE', 'ACTIVE'), status: null as unknown as string },
    ]);
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const allIds = PATIENT_KANBAN_STATUSES.flatMap((key) => result.current.groups[key].map((p) => p.id));
    expect(allIds).toEqual(['a']);
  });
  // ── Spec 051: o arrasto usa a MESMA lista do servidor que o select da ficha ──────────────────────
  describe('lista de destinos do servidor (GET status-options)', () => {
    it('lê a lista UMA vez por arrasto, do card arrastado, antes de qualquer PUT', async () => {
      const { result } = renderHook(() => usePatientKanban());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      await act(async () => { await result.current.moveStatus('c', 'ON_HOLD'); });
      expect(getPatientStatusOptions).toHaveBeenCalledTimes(1);
      expect(getPatientStatusOptions).toHaveBeenCalledWith('c', 'kanban'); // a origem do arrasto, explícita
      expect(getPatientStatusOptions.mock.invocationCallOrder[0]).toBeLessThan(updatePatientStatus.mock.invocationCallOrder[0]);
    });

    it('paciente do FUNIL arrastado para Búsqueda: com SEARCHING na lista (origem kanban) o PUT sai (D469)', async () => {
      getPatientStatusOptions.mockResolvedValue({ current: 'PENDING_ADMISSION', changeSource: 'kanban', options: [{ status: 'SEARCHING', via: 'fluxo' }, { status: 'ADMISSION', via: 'fluxo' }] });
      const { result } = renderHook(() => usePatientKanban());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      let err: PatientKanbanMoveError | null = null;
      await act(async () => { err = await result.current.moveStatus('d', 'SEARCHING'); });
      expect(err).toBeNull();
      expect(getPatientStatusOptions).toHaveBeenCalledWith('d', 'kanban');
      expect(updatePatientStatus).toHaveBeenCalledWith('d', { status: 'SEARCHING', changeSource: 'kanban' });
    });

    it('lista de OUTRA origem (o serviço recusa) → indisponível, sem PUT', async () => {
      getPatientStatusOptions.mockRejectedValue(new Error('status-options: origem admin_panel ≠ pedida kanban'));
      const { result } = renderHook(() => usePatientKanban());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      let err: PatientKanbanMoveError | null = null;
      await act(async () => { err = await result.current.moveStatus('d', 'SEARCHING'); });
      expect(err).toEqual({ code: 'STATUS_OPTIONS_UNAVAILABLE', to: 'SEARCHING' });
      expect(updatePatientStatus).not.toHaveBeenCalled();
    });

    it('destino que a lista não traz → STATUS_NOT_OFFERED, o PUT NÃO sai e o card não sai da coluna', async () => {
      getPatientStatusOptions.mockResolvedValue({ current: 'ACTIVE', options: [{ status: 'ON_HOLD', via: 'fluxo' }] });
      const { result } = renderHook(() => usePatientKanban());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      let err: PatientKanbanMoveError | null = null;
      await act(async () => { err = await result.current.moveStatus('c', 'SEARCHING'); });
      expect(err).toEqual({ code: 'STATUS_NOT_OFFERED', to: 'SEARCHING' });
      expect(updatePatientStatus).not.toHaveBeenCalled();
      expect(result.current.groups.ACTIVE.map((p) => p.id)).toEqual(['c']);
      expect(result.current.groups.SEARCHING).toEqual([]);
    });

    it('destino com blockedBy → devolve o 422 de completude com o que falta, sem chamar o PUT', async () => {
      getPatientStatusOptions.mockResolvedValue({ current: 'ACTIVE', options: [{ status: 'SEARCHING', via: 'permissao', blockedBy: ['SERVICE_SCHEDULE'] }] });
      const { result } = renderHook(() => usePatientKanban());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      let err: PatientKanbanMoveError | null = null;
      await act(async () => { err = await result.current.moveStatus('c', 'SEARCHING'); });
      expect(err).toEqual({ code: 'PATIENT_STATUS_NOT_READY', missing: ['SERVICE_SCHEDULE'], to: 'SEARCHING' });
      expect(updatePatientStatus).not.toHaveBeenCalled();
      expect(result.current.groups.ACTIVE.map((p) => p.id)).toEqual(['c']);
    });

    it('falha ao ler a lista → STATUS_OPTIONS_UNAVAILABLE, sem PUT e sem mover o card (nunca "tenta mesmo assim")', async () => {
      getPatientStatusOptions.mockRejectedValue(new Error('rede caiu'));
      const { result } = renderHook(() => usePatientKanban());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      let err: PatientKanbanMoveError | null = null;
      await act(async () => { err = await result.current.moveStatus('c', 'ON_HOLD'); });
      expect(err).toEqual({ code: 'STATUS_OPTIONS_UNAVAILABLE', to: 'ON_HOLD' });
      expect(updatePatientStatus).not.toHaveBeenCalled();
      expect(result.current.groups.ACTIVE.map((p) => p.id)).toEqual(['c']);
    });

    it('403 da lista (sem patient:update) → "sem permissão" (não "não deu para comprobar"), sem PUT e card no lugar', async () => {
      getPatientStatusOptions.mockRejectedValue(new PatientApiError('Forbidden', 403));
      const { result } = renderHook(() => usePatientKanban());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      let err: PatientKanbanMoveError | null = null;
      await act(async () => { err = await result.current.moveStatus('c', 'ON_HOLD'); });
      expect(err).toEqual({ code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED', to: 'ON_HOLD' });
      expect(updatePatientStatus).not.toHaveBeenCalled();
      expect(result.current.groups.ACTIVE.map((p) => p.id)).toEqual(['c']);
    });

    it('admisión → ACTIVE segue recusado ANTES da rede: nem a lista é lida', async () => {
      const { result } = renderHook(() => usePatientKanban());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      await act(async () => { await result.current.moveStatus('d', 'ACTIVE'); });
      expect(getPatientStatusOptions).not.toHaveBeenCalled();
    });
  });
});
