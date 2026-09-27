/**
 * itinerario-e2e-helper.ts
 *
 * Helpers do e2e de LEITURA do itinerário (Fase 7, change cadeia-paciente-vacante-itinerario,
 * P10 — DX-7.9, Q-EX-7.6): `GET /api/admin/patients/:id/itinerary` sem mock, com o serviço
 * criado pela API real e os slots vindos da DERIVAÇÃO (nunca de SQL) — só a alocação
 * (`patient_itinerary_assignment`) e a candidatura (`worker_job_applications`) entram por SQL,
 * porque os escritores são de outra fase (Q-EX-7.6: alocação é a Fase 11; a Fase 7 não tem porta
 * para a candidatura).
 *
 * Reusa sem copiar: `seedLaunchablePatient`/`backendUrl` (lancamento-e2e-helper.ts — paciente +
 * endereço + 1 serviço AT 20h/1 faixa seg 08:00-12:00, pela API real), `insertTestWorker`/
 * `cleanupTestWorker` (db-test-helper.ts), `insertWJA`/`cleanupWJAAndEncuadre` (wja-test-helper.ts),
 * `runSQL` (patient-detail-a-helper.ts), `tokenFor` (abac-stack-helper.ts), `seedMockStaff`/
 * `cleanupMockStaff` (vacancy-notes-e2e-helper.ts).
 *
 * URL só por `backendUrl()` (`lancamento-e2e-helper.ts:32-34`), lida DENTRO das funções — nunca
 * `throw` no import (o CI não exporta `E2E_BACKEND_URL` em todos os jobs e o Playwright carrega
 * todos os specs antes do `--grep`).
 */
import { type APIRequestContext } from '@playwright/test';
import { backendUrl, postContractedServiceViaApi } from './lancamento-e2e-helper';
import { runSQL } from './patient-detail-a-helper';
import { tokenFor, type MockUser } from './abac-stack-helper';

/** Espelha o CHECK `pia_status_check` da migration 480 (backend) — pacote diferente, não importa de lá. */
export type AssignmentStatus = 'ACTIVE' | 'ENDED' | 'CANCELLED';

/** Staff interno só para autenticar as chamadas de API deste helper (nunca exposto ao teste). */
export const ITINERARIO_STAFF: MockUser = {
  uid: 'e2e-int-admin-itinerario-f7',
  email: 'admin.itinerario.f7@e2e.test',
  role: 'admin',
  country: 'AR',
};

// ── GET /patients/:id/itinerary ─────────────────────────────────────────────────────

export interface ItineraryAssignmentDto {
  workerId: string;
  applicationId: string;
  validFrom: string;
  validTo: string | null;
  status: AssignmentStatus;
}

export interface ItinerarySlotDto {
  id: string;
  weekday: number;
  startTime: string;
  endTime: string;
  active: boolean;
  assignments: ItineraryAssignmentDto[];
}

export interface ItineraryServiceDto {
  contractedServiceId: string;
  contratadas: { weekly: number | null; authorized: number | null };
  cobertas: number;
  slots: ItinerarySlotDto[];
}

export interface ItineraryResponseDto {
  patientId: string;
  asOf: string;
  services: ItineraryServiceDto[];
}

export interface ReadItineraryResult {
  status: number;
  body: { success: boolean; data?: ItineraryResponseDto; error?: string; code?: string };
}

/** `GET /api/admin/patients/:id/itinerary` — nunca mocado; devolve status + corpo cru. */
export async function readItineraryApi(
  request: APIRequestContext,
  patientId: string,
): Promise<ReadItineraryResult> {
  const token = tokenFor(ITINERARIO_STAFF);
  const res = await request.get(`${backendUrl()}/api/admin/patients/${patientId}/itinerary`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const status = res.status();
  const body = (await res.json().catch(() => ({ success: false }))) as ReadItineraryResult['body'];
  return { status, body };
}

// ── POST .../activate-recruitment (o mesmo endpoint do foguete) ─────────────────────

/**
 * `POST /patients/:id/contracted-services/:sid/activate-recruitment` — molde `clickFoguete`
 * (`lancamento-e2e-helper.ts:327-351`), sem tela: a vaga nasce do MESMO `contracted_service_id`
 * do serviço (é o que a trigger de candidatura da migration 480 exige — a WJA gravada contra
 * essa vaga aponta para o serviço certo).
 */
export async function activateRecruitmentViaApi(
  request: APIRequestContext,
  patientId: string,
  serviceId: string,
): Promise<string> {
  const token = tokenFor(ITINERARIO_STAFF);
  const res = await request.post(
    `${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok()) {
    throw new Error(
      `activateRecruitmentViaApi: falhou ${res.status()}: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { data?: { vacancyId?: string } };
  const vacancyId = body.data?.vacancyId;
  if (!vacancyId) throw new Error('activateRecruitmentViaApi: resposta sem vacancyId');
  return vacancyId;
}

// ── POST .../contracted-services (2º serviço, com/sem horário) ──────────────────────

export interface CreateServiceViaApiOpts {
  serviceCode?: 'AT' | 'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST' | 'PSYCHOLOGIST';
  weeklyHours?: number;
  addressId: string;
  schedule?: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
}

/**
 * `POST /patients/:id/contracted-services` — wrapper de `postContractedServiceViaApi`
 * (`lancamento-e2e-helper.ts`, G2: fonte única do POST, antes duplicado aqui). Mesmos defaults
 * de antes (`serviceCode` AT, `providersNeeded` 1, `weeklyHours` 20, `careLocation` HOME),
 * `schedule` opcional.
 */
export async function createServiceViaApi(
  request: APIRequestContext,
  patientId: string,
  opts: CreateServiceViaApiOpts,
): Promise<string> {
  const token = tokenFor(ITINERARIO_STAFF);
  return postContractedServiceViaApi(request, token, patientId, {
    serviceCode: opts.serviceCode ?? 'AT',
    providersNeeded: 1,
    weeklyHours: opts.weeklyHours ?? 20,
    careLocation: 'HOME',
    addressId: opts.addressId,
    ...(opts.schedule ? { schedule: opts.schedule } : {}),
  });
}

// ── Alocação por SQL (Q-EX-7.6: o escritor é da Fase 11) ────────────────────────────

export interface SeedAssignmentOpts {
  slotId: string;
  workerId: string;
  applicationId: string;
  /** `valid_from` = hoje (fuso Buenos Aires, pelo BANCO) menos N dias. */
  validFromDaysAgo: number;
  /** Omitido = `valid_to` NULL (vigente sem fim). Informado = hoje − N dias. */
  validToDaysAgo?: number;
  status: AssignmentStatus;
}

/**
 * INSERT direto em `patient_itinerary_assignment` — datas calculadas PELO BANCO
 * (`(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - N`, nunca pelo relógio do
 * runner, regra 7 do brief). Devolve o `id` da alocação (via `RETURNING id`, único valor que o
 * `runSQL` de `patient-detail-a-helper.ts` devolve com `-tAc`).
 */
export function seedAssignment(opts: SeedAssignmentOpts): string {
  const { slotId, workerId, applicationId, validFromDaysAgo, validToDaysAgo, status } = opts;
  const validToSql =
    validToDaysAgo !== undefined
      ? `(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - ${validToDaysAgo}`
      : 'NULL';
  const id = runSQL(
    `INSERT INTO patient_itinerary_assignment ` +
      `(slot_id, worker_id, application_id, valid_from, valid_to, status, created_by, updated_by) VALUES (` +
      `'${slotId}', '${workerId}', '${applicationId}', ` +
      `(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - ${validFromDaysAgo}, ${validToSql}, ` +
      `'${status}', 'e2e-itinerario-p10', 'e2e-itinerario-p10') RETURNING id`,
  );
  if (!id) throw new Error('seedAssignment: INSERT não devolveu id');
  return id;
}

// ── Limpeza ──────────────────────────────────────────────────────────────────────────

/**
 * Apaga as alocações dos slots dos serviços do paciente — SEMPRE antes de
 * `cleanupPatientDeep` (a FK `NO ACTION` de `patient_itinerary_assignment.slot_id`/`.application_id`
 * recusaria a cascata de `job_postings`/`patient_contracted_services`, regra 8 do brief).
 */
export function cleanupItinerary(patientId: string): void {
  if (!patientId) return;
  runSQL(
    `DELETE FROM patient_itinerary_assignment WHERE slot_id IN (` +
      `SELECT pis.id FROM patient_itinerary_slot pis ` +
      `JOIN patient_contracted_services pcs ON pcs.id = pis.contracted_service_id ` +
      `WHERE pcs.patient_id = '${patientId}')`,
  );
}
