/**
 * derivacao-e2e-helper.ts
 *
 * Helper do e2e de API da derivação do estado do paciente (Fase 15, change
 * cadeia-paciente-vacante-itinerario, P20 — DX-15.14). Só o que os irmãos ainda não têm: a semente
 * de um paciente DERIVÁVEL (status inicial dado, endereço, consentimento, cobertura informada, N
 * serviços com horário e vaga viva), o candidato em Selecionado (C), a leitura do status pela API
 * E pelo banco, a soma de `cobertas` do itinerário e a contagem da trilha `system`.
 *
 * A ordem da semente é a medida no smoke do P15 (a): paciente por SQL → serviço pela API →
 * `activate-recruitment` pela API (o status inicial NÃO muda) → slots lidos do itinerário. Toda
 * escrita da fase (alocar, encerrar, montar, rejeitar/reverter em C, ausência) fica com o teste,
 * pela API; este helper não escreve o status do paciente (ele nasce no `insertTestPatient`).
 *
 * Reusa sem copiar: `backendUrl()` (`lancamento-e2e-helper.ts:32`, lida DENTRO das funções — nunca
 * no topo do módulo, o Playwright carrega todos os specs antes do `--grep`), `insertTestPatient`/
 * `insertTestWorker`/`cleanupTestWorker` (`db-test-helper.ts`), `insertWJA`/`cleanupWJAAndEncuadre`
 * (`wja-test-helper.ts`), `createServiceViaApi`/`activateRecruitmentViaApi`/`readItineraryApi`/
 * `ITINERARIO_STAFF` (`itinerario-e2e-helper.ts`), `allocateApi`/`patientStatus`/`insertSecondAddress`
 * (`itinerario-escrita-e2e-helper.ts`), `readPatientStatusApi` (`funnel-move-e2e-helper.ts:212`),
 * `cleanupSubstituicao` (`substituicao-e2e-helper.ts:175` — ausência → alocação → marcas → montado),
 * `cleanupPatientDeep` (`patient-detail-a-helper.ts:66`), `runSQL`, `tokenFor`.
 *
 * Limpeza por `patient_id`, na ordem da regra 13 do brief: ausência → alocação → marcas de C →
 * montado → WJA/vaga → worker → serviço → paciente. `patient_status_history` sai pela cascata da FK
 * (`patient_status_history_patient_id_fkey`, `ON DELETE CASCADE`, conferida no DDL em 29/09).
 *
 * Nenhum host/porta literal, nenhum `throw` no import, nenhuma data do relógio do runner.
 */
import { type APIRequestContext } from '@playwright/test';
import { backendUrl } from './lancamento-e2e-helper';
import { insertTestPatient, insertTestWorker, cleanupTestWorker } from './db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from './wja-test-helper';
import {
  createServiceViaApi, activateRecruitmentViaApi, readItineraryApi, ITINERARIO_STAFF,
} from './itinerario-e2e-helper';
import { allocateApi, patientStatus, insertSecondAddress } from './itinerario-escrita-e2e-helper';
import { readPatientStatusApi } from './funnel-move-e2e-helper';
import { cleanupSubstituicao } from './substituicao-e2e-helper';
import { cleanupPatientDeep, runSQL } from './patient-detail-a-helper';
import { tokenFor } from './abac-stack-helper';

/** Marca SINTÉTICA da massa desta fase — o `first_name` do paciente e o `last_name` do worker. */
export const DERIVACAO_MARK = 'DerivacaoE2E';

export interface DerivableServiceSpec {
  weeklyHours: number;
  schedule: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
  /** `true` = o serviço vai para um 2º endereço do MESMO paciente (`insertSecondAddress`). */
  secondAddress?: boolean;
}

export interface SeedDerivableOpts {
  status: string;
  services: DerivableServiceSpec[];
  /** Coordenadas do endereço principal; default o centro de CABA do P15. */
  lat?: number;
  lng?: number;
}

export interface DerivableService {
  serviceId: string;
  vacancyId: string;
  /** Os slots do serviço, ordenados por dia da semana e hora de início. */
  slotIds: string[];
}

export interface DerivableSeed {
  patientId: string;
  addressId: string;
  services: DerivableService[];
  /** Registra um worker para a limpeza (WJA da vaga + worker). */
  track: (workerId: string, vacancyId: string) => void;
  cleanup: () => void;
}

/** Token do staff dos helpers do itinerário (o mesmo de `readItineraryApi`). */
export function derivacaoToken(): string {
  return tokenFor(ITINERARIO_STAFF);
}

/**
 * Paciente derivável: `insertTestPatient` com endereço + consentimento + cobertura (a completude
 * do P15), e por serviço `createServiceViaApi` → `activateRecruitmentViaApi` → slots lidos de
 * `readItineraryApi`. Se qualquer passo falhar, limpa o que já nasceu antes de relançar.
 */
export async function seedDerivablePatient(
  request: APIRequestContext,
  opts: SeedDerivableOpts,
): Promise<DerivableSeed> {
  const { patientId, addressId } = insertTestPatient({
    status: opts.status,
    firstName: DERIVACAO_MARK,
    withAddress: true,
    addressLat: opts.lat ?? -34.6,
    addressLng: opts.lng ?? -58.4,
    hasConsent: true,
    insuranceInformed: 'OSDE',
  });
  const tracked: Array<{ workerId: string; vacancyId: string }> = [];
  const cleanup = (): void => {
    cleanupSubstituicao(patientId);
    for (const t of tracked) cleanupWJAAndEncuadre(t.workerId, t.vacancyId);
    for (const workerId of new Set(tracked.map((t) => t.workerId))) cleanupTestWorker(workerId);
    cleanupPatientDeep(patientId);
  };
  const track = (workerId: string, vacancyId: string): void => {
    tracked.push({ workerId, vacancyId });
  };

  try {
    if (!addressId) throw new Error('seedDerivablePatient: insertTestPatient não devolveu addressId');
    let secondAddressId: string | null = null;
    const created: Array<{ serviceId: string; vacancyId: string }> = [];
    for (const spec of opts.services) {
      if (spec.secondAddress && !secondAddressId) secondAddressId = insertSecondAddress(patientId);
      const serviceId = await createServiceViaApi(request, patientId, {
        weeklyHours: spec.weeklyHours,
        addressId: spec.secondAddress && secondAddressId ? secondAddressId : addressId,
        schedule: spec.schedule,
      });
      const vacancyId = await activateRecruitmentViaApi(request, patientId, serviceId);
      created.push({ serviceId, vacancyId });
    }
    const itin = await readItineraryApi(request, patientId);
    if (itin.status !== 200) throw new Error(`seedDerivablePatient: itinerário ${itin.status}`);
    const services = created.map(({ serviceId, vacancyId }) => {
      const svc = itin.body.data?.services.find((s) => s.contractedServiceId === serviceId);
      const slotIds = [...(svc?.slots ?? [])]
        .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime))
        .map((s) => s.id);
      if (slotIds.length === 0) throw new Error(`seedDerivablePatient: serviço ${serviceId} sem slot`);
      return { serviceId, vacancyId, slotIds };
    });
    return { patientId, addressId, services, track, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Candidato em Selecionado (C) da vaga: `insertTestWorker` (AT, marca sintética) + `insertWJA`
 * na etapa dada (default `QUICK_RESPONSE_TEAM`). Registra no `seed` para a limpeza.
 */
export function selectedWorker(
  seed: DerivableSeed,
  vacancyId: string,
  funnelStage = 'QUICK_RESPONSE_TEAM',
): string {
  const workerId = insertTestWorker({ occupation: 'AT', lastName: DERIVACAO_MARK });
  seed.track(workerId, vacancyId);
  insertWJA({ workerId, jobPostingId: vacancyId, funnelStage });
  return workerId;
}

export interface AllocateResult {
  status: number;
  code?: string;
  allocationId: string | null;
}

/** `allocateApi` com o token do helper; devolve o status e o `allocationId` (o teste decide). */
export async function allocateWorker(
  request: APIRequestContext,
  patientId: string,
  serviceId: string,
  slotId: string,
  workerId: string,
): Promise<AllocateResult> {
  const r = await allocateApi(request, derivacaoToken(), patientId, serviceId, slotId, { workerId });
  const allocationId = (r.body.data as { allocationId?: string } | undefined)?.allocationId ?? null;
  return { status: r.status, code: r.body.code, allocationId };
}

export interface StatusReading {
  api: string | null;
  db: string;
}

/** O status do paciente lido pela API (`GET /api/admin/patients/:id`) E pelo banco. */
export async function readStatusBoth(request: APIRequestContext, patientId: string): Promise<StatusReading> {
  const api = await readPatientStatusApi(request, backendUrl(), derivacaoToken(), patientId);
  return { api, db: patientStatus(patientId) };
}

/** Soma de `cobertas` de todos os serviços do itinerário (a conta da Fase 7, lida pela API). */
export async function coveredHours(request: APIRequestContext, patientId: string): Promise<number> {
  const itin = await readItineraryApi(request, patientId);
  if (itin.status !== 200) throw new Error(`coveredHours: itinerário ${itin.status}`);
  return (itin.body.data?.services ?? []).reduce((acc, s) => acc + s.cobertas, 0);
}

/** Linhas de `patient_status_history` do paciente com o `change_source` dado (molde `countLaunchTrail`). */
export function countTrailBySource(patientId: string, source: string): number {
  return Number(
    runSQL(
      `SELECT count(*) FROM patient_status_history WHERE patient_id = '${patientId}' AND change_source = '${source}'`,
    ).trim(),
  );
}

/** A trilha da derivação: `change_source = 'system'`. */
export function countSystemTrail(patientId: string): number {
  return countTrailBySource(patientId, 'system');
}
