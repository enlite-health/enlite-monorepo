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
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listPatientsForKanban: (...a: unknown[]) => listPatientsForKanban(...a),
    updatePatientStatus: (...a: unknown[]) => updatePatientStatus(...a),
  },
}));

// DX-8.9/8.16: o agregado do subcard do Kanban, buscado EM PARALELO com a listagem. Default
// `{ patients: [] }` — sem ele, o hook chamaria `fetch` real (nenhum dos 9 testes acima do agregado
// precisa saber disso).
const listKanbanServices = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    listKanbanServices: (...a: unknown[]) => listKanbanServices(...a),
  },
  ContractedServiceApiError: class ContractedServiceApiError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = 'ContractedServiceApiError';
      this.status = status;
    }
  },
}));

import {
  usePatientKanban,
  PATIENT_KANBAN_STATUSES,
  KANBAN_ACTIVATION_MOVED_TO_SERVICE,
  type PatientKanbanMoveError,
} from '../usePatientKanban';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientKanbanServiceSummary } from '@domain/entities/PatientDetail';

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
    listKanbanServices.mockReset().mockResolvedValue({ patients: [] });
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
    expect(err).toEqual({ code: '422 transição', missing: undefined });
    expect(result.current.groups.ADMISSION.map((p) => p.id)).toEqual(['a', 'd']);
    await act(async () => { err = await result.current.moveStatus('nao-existe', 'ADMISSION'); });
    expect(result.current.groups.ADMISSION.map((p) => p.id)).toEqual(['a', 'd']);
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

  // DX-8.9: a listagem e o agregado saem no MESMO tick (Promise.allSettled dispara as duas
  // chamadas antes de qualquer await resolver) — nunca uma chamada por card/coluna.
  it('busca listagem e agregado em paralelo, uma vez cada, com o mesmo country', async () => {
    const { result } = renderHook(() => usePatientKanban('BR'));
    expect(listPatientsForKanban).toHaveBeenCalledTimes(1);
    expect(listKanbanServices).toHaveBeenCalledTimes(1);
    expect(listPatientsForKanban).toHaveBeenCalledWith('BR');
    expect(listKanbanServices).toHaveBeenCalledWith('BR');
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  // DX-8.9: casamento por patientId — 2 pacientes, um deles com 2 serviços; quem não está no
  // agregado (ou o agregado não trouxe) recebe `[]`, nunca `undefined`, quando servicesStatus é 'ok'.
  it('casa os serviços do agregado por patientId; paciente com 2 serviços mostra os 2, os demais ficam com []', async () => {
    const svcA1: PatientKanbanServiceSummary = {
      contractedServiceId: 's1', serviceCode: 'AT', contratadas: { weekly: 20, authorized: 20 }, cobertas: 4, liveVacancyId: null,
    };
    const svcA2: PatientKanbanServiceSummary = {
      contractedServiceId: 's2', serviceCode: 'ENF', contratadas: { weekly: 10, authorized: 10 }, cobertas: 0, liveVacancyId: 'v1',
    };
    listKanbanServices.mockResolvedValueOnce({
      patients: [{ patientId: 'a', asOf: '2026-09-27', services: [svcA1, svcA2] }],
    });
    const { result } = renderHook(() => usePatientKanban('AR'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.servicesStatus).toBe('ok');
    const a = result.current.groups.ADMISSION.find((p) => p.id === 'a');
    const d = result.current.groups.ADMISSION.find((p) => p.id === 'd');
    expect(a?.services).toEqual([svcA1, svcA2]);
    expect(d?.services).toEqual([]);
  });

  // DX-8.9: 403 — o ator não tem `patient_services:read`. Silencioso: sem subcard, sem aviso.
  it('agregado 403 → servicesStatus "forbidden", nenhum item ganha `services`', async () => {
    listKanbanServices.mockReset().mockRejectedValueOnce(new ContractedServiceApiError('Forbidden', 403));
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.servicesStatus).toBe('forbidden');
    expect(result.current.error).toBeNull();
    for (const key of PATIENT_KANBAN_STATUSES) {
      for (const p of result.current.groups[key]) expect(p.services).toBeUndefined();
    }
  });

  // DX-8.9: qualquer OUTRA falha do agregado (500, rede) → servicesStatus "error"; o board
  // continua renderizando (a página, não o hook, mostra o aviso — P13).
  it('agregado com outra falha (500) → servicesStatus "error", sem derrubar a página', async () => {
    listKanbanServices.mockReset().mockRejectedValueOnce(new ContractedServiceApiError('Internal error', 500));
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.servicesStatus).toBe('error');
    expect(result.current.error).toBeNull();
    expect(result.current.groups.ADMISSION.map((p) => p.id)).toEqual(['a', 'd']);
  });

  // DX-8.9: o `moveStatus` otimista já copia o item inteiro (`{ ...card, status }`) — o subcard
  // anda com o card sem refetch do agregado.
  it('moveStatus otimista preserva os `services` do card movido', async () => {
    const svc: PatientKanbanServiceSummary = {
      contractedServiceId: 's1', serviceCode: 'AT', contratadas: { weekly: 20, authorized: 20 }, cobertas: 4, liveVacancyId: null,
    };
    listKanbanServices.mockReset().mockResolvedValueOnce({
      patients: [{ patientId: 'a', asOf: '2026-09-27', services: [svc] }],
    });
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const before = result.current.groups.ADMISSION.find((p) => p.id === 'a');
    expect(before?.services).toEqual([svc]);
    await act(async () => { await result.current.moveStatus('a', 'SEARCHING'); });
    const moved = result.current.groups.SEARCHING.find((p) => p.id === 'a');
    expect(moved?.services).toEqual([svc]);
  });
});
