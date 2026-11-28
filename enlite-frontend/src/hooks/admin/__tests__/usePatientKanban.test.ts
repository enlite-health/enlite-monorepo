/**
 * usePatientKanban — o board agrupa por `patients.status` (estado clínico v2). Colunas: ADMISSION (junta os 3 estados do funil
 * antigo: SOLICITANTE / ADMISSION / PENDING_ADMISSION) / SEARCHING / REPLACEMENT / ACTIVE / ON_HOLD / SUSPENDED / ALTA / DISCHARGED.
 * F5 (estado-automatico-do-paciente): o board é SÓ DE LEITURA — o hook não move card (nenhum PUT /status, nenhuma lista de destinos).
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

import { usePatientKanban, PATIENT_KANBAN_STATUSES } from '../usePatientKanban';
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
      contractedServiceId: 's1', serviceCode: 'AT', scheduleHours: 20, cobertas: 4, reserve: null, liveVacancyId: null,
    };
    const svcA2: PatientKanbanServiceSummary = {
      contractedServiceId: 's2', serviceCode: 'ENF', scheduleHours: 10, cobertas: 0, reserve: null, liveVacancyId: 'v1',
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

  // F5: o board não move card — o hook não devolve `moveStatus` e carregar o board nunca escreve estado.
  it('o hook é só de leitura: não expõe moveStatus e carregar nunca chama o PUT de estado', async () => {
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(Object.keys(result.current).sort()).toEqual(['error', 'groups', 'isLoading', 'refetch', 'servicesStatus']);
    expect(updatePatientStatus).not.toHaveBeenCalled();
  });

  // semaforo-da-vaga F3: a pior cor vem PRONTA do agregado (`worstSemaphore`) — o hook só a repassa ao item, sem escolher.
  it('agregado ok → cada item ganha worstSemaphore do agregado (null quando o paciente não tem serviço com vaga); o semáforo do serviço passa intacto', async () => {
    const svc = (id: string, semaphore: PatientKanbanServiceSummary['semaphore']): PatientKanbanServiceSummary => ({
      contractedServiceId: id, serviceCode: 'AT', scheduleHours: 10, reserve: null, cobertas: 0, liveVacancyId: null, semaphore,
    });
    listKanbanServices.mockReset().mockResolvedValueOnce({
      patients: [
        { patientId: 'a', asOf: 'x', worstSemaphore: 'red', services: [svc('s1', { n: 0, color: 'red' }), svc('s2', { n: 12, color: 'green' })] },
        { patientId: 'c', asOf: 'x', worstSemaphore: null, services: [svc('s3', null)] },
      ],
    });
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const a = result.current.groups.ADMISSION.find((p) => p.id === 'a')!;
    expect(a.worstSemaphore).toBe('red');
    expect(a.services!.map((s) => s.semaphore)).toEqual([{ n: 0, color: 'red' }, { n: 12, color: 'green' }]);
    expect(result.current.groups.ACTIVE.find((p) => p.id === 'c')!.worstSemaphore).toBeNull();
    expect(result.current.groups.ON_HOLD.find((p) => p.id === 'b')!.worstSemaphore).toBeNull(); // fora do agregado = sem serviço = null
  });

  it('agregado 403/erro → worstSemaphore undefined (o filtro some e nada é filtrado)', async () => {
    listKanbanServices.mockReset().mockRejectedValueOnce(new ContractedServiceApiError('Forbidden', 403));
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    for (const key of PATIENT_KANBAN_STATUSES) {
      for (const p of result.current.groups[key]) expect(p.worstSemaphore).toBeUndefined();
    }
  });
});
