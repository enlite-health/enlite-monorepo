/**
 * usePatientKanban — spec 012, US-B7: o board passa a ler `admissionStatus` (funil de admissão,
 * migration 313), não `status` (estado clínico v2). Colunas: SOLICITANTE / ADMISSION /
 * PENDING_ADMISSION / DONE ("Activo"). Mover DENTRO do funil chama `PUT /status` com
 * `changeSource: 'kanban'` — é a coluna "origem" do Historial. Soltar em DONE MUDOU (spec 018,
 * PR-6, ADR-5): a migration 428 tira funil→ACTIVE do catálogo, então o hook NÃO chama mais a
 * API — devolve `KANBAN_ACTIVATION_MOVED_TO_SERVICE` na hora, sem tocar o agrupamento. Ativar
 * virou uma ação por SERVIÇO (`ServicosContratadosCard`, "Activar reclutamiento").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const listPatientsForKanban = vi.fn();
const updatePatientStatus = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listPatientsForKanban: (...a: unknown[]) => listPatientsForKanban(...a),
    updatePatientStatus: (...a: unknown[]) => updatePatientStatus(...a),
  },
}));

import {
  usePatientKanban,
  PATIENT_KANBAN_STATUSES,
  KANBAN_ACTIVATION_MOVED_TO_SERVICE,
  type PatientKanbanMoveError,
} from '../usePatientKanban';

const item = (id: string, admissionStatus: string, status: string) => ({
  id, firstName: 'P', lastName: id, caseNumber: null, dependencyLevel: null, status, admissionStatus, responsibleName: null,
});

describe('usePatientKanban — admission_status', () => {
  beforeEach(() => {
    listPatientsForKanban.mockReset().mockResolvedValue([
      item('a', 'SOLICITANTE', 'SOLICITANTE'),
      item('b', 'DONE', 'ON_HOLD'),      // em espera: já passou pela admissão → coluna "Activo"
      item('c', 'DONE', 'ACTIVE'),
      item('d', 'PENDING_ADMISSION', 'PENDING_ADMISSION'),
    ]);
    updatePatientStatus.mockReset().mockResolvedValue({ id: 'x', status: 'ACTIVE' });
  });

  it('as colunas são o funil + DONE, e o agrupamento é por admissionStatus (ON_HOLD cai em DONE)', async () => {
    expect([...PATIENT_KANBAN_STATUSES]).toEqual(['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION', 'DONE']);
    const { result } = renderHook(() => usePatientKanban('AR'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(listPatientsForKanban).toHaveBeenCalledWith('AR');
    expect(result.current.groups.SOLICITANTE.map((p) => p.id)).toEqual(['a']);
    expect(result.current.groups.DONE.map((p) => p.id)).toEqual(['b', 'c']);
    expect(result.current.groups.PENDING_ADMISSION.map((p) => p.id)).toEqual(['d']);
    expect(result.current.groups.ADMISSION).toEqual([]);
  });

  // Spec 018, PR-6, ADR-5: a migration 428 tira funil→ACTIVE do catálogo. Soltar em DONE não
  // chama mais `PUT /status` — o hook recusa ANTES da rede, sem tocar o agrupamento (o card fica
  // onde estava; não há otimismo a desfazer). Mover DENTRO do funil continua livre e chama a API
  // com o próprio alvo (sem tradução para ACTIVE).
  it('mover para DONE NÃO chama a API — devolve KANBAN_ACTIVATION_MOVED_TO_SERVICE sem mexer no agrupamento; mover dentro do funil chama updatePatientStatus normalmente', async () => {
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      expect(await result.current.moveStatus('d', 'DONE')).toEqual({ code: KANBAN_ACTIVATION_MOVED_TO_SERVICE });
    });
    expect(updatePatientStatus).not.toHaveBeenCalled();
    // 'd' continua em PENDING_ADMISSION — não mudou de coluna nenhuma.
    expect(result.current.groups.PENDING_ADMISSION.map((p) => p.id)).toEqual(['d']);
    expect(result.current.groups.DONE.map((p) => p.id)).toEqual(['b', 'c']);

    await act(async () => { await result.current.moveStatus('a', 'ADMISSION'); });
    expect(updatePatientStatus).toHaveBeenLastCalledWith('a', { status: 'ADMISSION', changeSource: 'kanban' });
  });

  it('falha no PUT (dentro do funil) restaura o agrupamento anterior e devolve a mensagem; card desconhecido não muda nada', async () => {
    updatePatientStatus.mockRejectedValueOnce(new Error('422 transição'));
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let err: PatientKanbanMoveError | null = null;
    await act(async () => { err = await result.current.moveStatus('a', 'ADMISSION'); });
    expect(err).toEqual({ code: '422 transição', missing: undefined });
    expect(result.current.groups.SOLICITANTE.map((p) => p.id)).toEqual(['a']);
    await act(async () => { err = await result.current.moveStatus('nao-existe', 'ADMISSION'); });
    expect(result.current.groups.SOLICITANTE.map((p) => p.id)).toEqual(['a']);
    updatePatientStatus.mockRejectedValueOnce('string-error');
    await act(async () => { err = await result.current.moveStatus('a', 'ADMISSION'); });
    expect(err).toEqual({ code: 'Failed to move patient' });
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
    });
    expect(JSON.stringify(err)).not.toContain('Juan Pérez');
    // o card volta para a coluna de origem (rollback otimista)
    expect(result.current.groups.SOLICITANTE.map((p) => p.id)).toEqual(['a']);
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

    expect(err).toEqual({ code: 'PATIENT_STATUS_NOT_READY', missing: undefined });
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
});
