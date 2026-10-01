/**
 * itinerario-escrita-e2e-helper.ts
 *
 * Helpers dos ESCRITORES do itinerário (Fase 11, change cadeia-paciente-vacante-itinerario,
 * P24 — DX-11.18, insumo das DX-11.2 a 11.16). Wrappers CRUS das 7 rotas novas
 * (`CASE/interfaces/routes/adminItineraryWriteRoutes.ts`, DX-11.9 — ainda sendo fechadas em
 * `worker-functions/` por outro agente nesta sessão, não tocado aqui): cada um devolve
 * `{ status, body }` sem `expect` — o teste decide o esperado (feliz e os 400/404/409/422). Mais
 * as sementes por SQL que nenhum escritor de API cobre ainda (serviço sem endereço, serviço com
 * vaga viva) e a limpeza do que esta fase grava.
 *
 * Reusa sem copiar: `backendUrl()` (`lancamento-e2e-helper.ts:32-34`, mesmo fallback do CI dos
 * irmãos, lida DENTRO das funções — nunca no topo do módulo, o Playwright carrega todos os specs
 * antes do `--grep`), `runSQL` (`patient-detail-a-helper.ts:9`), `insertBaseVacancy` (`db-test-helper.ts:339`),
 * `cleanupQuadroC` (`quadro-c-e2e-helper.ts:147`). Nenhum host/porta literal, nenhum `throw` no
 * import, nenhum `fill()` — esta fase não tem tela (a tela é a Fase 12), só API.
 */
import { type APIRequestContext } from '@playwright/test';
import { backendUrl } from './lancamento-e2e-helper';
import { runSQL } from './patient-detail-a-helper';
import { insertBaseVacancy } from './db-test-helper';
import { cleanupQuadroC } from './quadro-c-e2e-helper';

export interface ItineraryWriteApiResult<T = unknown> {
  status: number;
  body: { success: boolean; data?: T; error?: string; code?: string; [k: string]: unknown };
}

/** Corpo CRU — o teste decide o que manda (inclusive payload incompleto, para os 400/422). */
export type ItineraryWriteBody = Record<string, unknown>;

/**
 * Chamada crua comum às 7 rotas: URL só por `backendUrl()`, lida aqui dentro (nunca no topo do
 * módulo). Devolve `{ status, body }` cru — nenhum `expect`, quem decide é o teste.
 */
async function callItineraryWriteApi<T = unknown>(
  request: APIRequestContext,
  method: 'get' | 'post' | 'patch',
  path: string,
  token: string,
  body?: ItineraryWriteBody,
): Promise<ItineraryWriteApiResult<T>> {
  const res = await request[method](`${backendUrl()}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { data: body } : {}),
  });
  const status = res.status();
  const responseBody = (await res.json().catch(() => ({ success: false }))) as ItineraryWriteApiResult<T>['body'];
  return { status, body: responseBody };
}

// ── As 7 rotas (DX-11.9) ─────────────────────────────────────────────────────────────

/** `GET /patients/:id/contracted-services/:sid/allocation-options`. */
export function allocationOptionsApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
): Promise<ItineraryWriteApiResult> {
  return callItineraryWriteApi(
    request, 'get',
    `/api/admin/patients/${patientId}/contracted-services/${serviceId}/allocation-options`,
    token,
  );
}

/** `POST /patients/:id/contracted-services/:sid/itinerary/slots`. */
export function postSlotApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
  body: ItineraryWriteBody,
): Promise<ItineraryWriteApiResult> {
  return callItineraryWriteApi(
    request, 'post',
    `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots`,
    token, body,
  );
}

/** `PATCH /patients/:id/contracted-services/:sid/itinerary/slots/:slotId`. */
export function patchSlotApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
  slotId: string,
  body: ItineraryWriteBody,
): Promise<ItineraryWriteApiResult> {
  return callItineraryWriteApi(
    request, 'patch',
    `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotId}`,
    token, body,
  );
}

/** `POST /patients/:id/contracted-services/:sid/itinerary/slots/:slotId/end`. */
export function endSlotApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
  slotId: string,
): Promise<ItineraryWriteApiResult> {
  return callItineraryWriteApi(
    request, 'post',
    `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotId}/end`,
    token,
  );
}

/** `POST /patients/:id/contracted-services/:sid/itinerary/slots/:slotId/allocations`. */
export function allocateApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
  slotId: string,
  body: ItineraryWriteBody,
): Promise<ItineraryWriteApiResult> {
  return callItineraryWriteApi(
    request, 'post',
    `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotId}/allocations`,
    token, body,
  );
}

/**
 * `POST /patients/:id/contracted-services/:sid/itinerary/allocations/:allocationId/end`. Desde a Fase 4 (change
 * itinerario-trocas-motivos-e-figma) o corpo `{ reasonCategory, destination }` é obrigatório; o padrão é um motivo
 * do catálogo (`OTHER`) e `RESERVE` (o prestador segue em Selecionado — o efeito do `end` de antes).
 */
export function endAllocationApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
  allocationId: string,
  body: ItineraryWriteBody = { reasonCategory: 'OTHER', destination: 'RESERVE' },
): Promise<ItineraryWriteApiResult> {
  return callItineraryWriteApi(
    request, 'post',
    `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/allocations/${allocationId}/end`,
    token, body,
  );
}

/** `POST /patients/:id/itinerary/assemble`. */
export function assembleApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
): Promise<ItineraryWriteApiResult> {
  return callItineraryWriteApi(
    request, 'post',
    `/api/admin/patients/${patientId}/itinerary/assemble`,
    token,
  );
}

// ── Sementes por SQL (o que nenhum escritor de API cobre) ───────────────────────────

/**
 * `runSQL` (`patient-detail-a-helper.ts:9`): `psql -tAc "INSERT … RETURNING id"` neste container
 * imprime a tupla E o tag de comando ("INSERT 0 1") na MESMA saída — extrai só o UUID.
 *
 * MOVIDO de `kanban-pacientes-quadro-c.integration.e2e.ts:41-52` (Fase 10, DX-10.13) para este
 * helper compartilhado (P24, DX-11.18) — texto igual, agora `export`; o spec passa a importar
 * daqui, nenhuma asserção dele muda.
 */
export function extractUuid(raw: string): string {
  const found = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (!found) throw new Error(`extractUuid: nenhum uuid na saída do psql (semente falhou?): ${raw}`);
  return found;
}

/**
 * 2º endereço do paciente (`quadro-c-por-servico`, critério 13) — SQL direto: nenhum helper de
 * API grava endereço nesta pasta ainda.
 *
 * MOVIDO de `kanban-pacientes-quadro-c.integration.e2e.ts:54-70` (Fase 10, DX-10.13) para este
 * helper compartilhado (P24, DX-11.18) — texto igual, agora `export`; o spec passa a importar
 * daqui, nenhuma asserção dele muda.
 */
export function insertSecondAddress(patientId: string): string {
  return extractUuid(
    runSQL(
      `INSERT INTO patient_addresses (patient_id, is_default, address_type, address_formatted, address_raw, ` +
        `lat, lng, display_order, source, created_at, updated_at) VALUES ('${patientId}', false, NULL, ` +
        `'Av. Santa Fe 2000, CABA, AR', 'Av. Santa Fe 2000, CABA', -34.595, -58.393, 2, 'manual', NOW(), NOW()) ` +
        `RETURNING id`,
    ),
  );
}

/** Conta alocações `ACTIVE` de um worker em `patient_itinerary_assignment` (o gate 5(iv)). */
export function countActiveAllocations(workerId: string): number {
  return Number(
    runSQL(`SELECT count(*) FROM patient_itinerary_assignment WHERE worker_id = '${workerId}' AND status = 'ACTIVE'`),
  );
}

/** Status atual do paciente — usado para provar "nada move o paciente" (invariante 3, Fase 15). */
export function patientStatus(patientId: string): string {
  return runSQL(`SELECT status FROM patients WHERE id = '${patientId}'`);
}

/**
 * Serviço AT ativo AR sem `address_id` (molde `ficha-a1-helper.ts:33-34`) — insumo do 422
 * `SERVICE_WITHOUT_ADDRESS` (DX-11.10). Devolve o id do serviço.
 */
export function insertServiceNoAddressSql(patientId: string): string {
  return extractUuid(
    runSQL(
      `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by) ` +
        `VALUES ('${patientId}', 'AT', true, 'AR', 'e2e-itinerario-escrita-p24', 'e2e-itinerario-escrita-p24') ` +
        `RETURNING id`,
    ),
  );
}

export interface ServiceWithVacancySeed {
  serviceId: string;
  vacancyId: string;
}

/**
 * Serviço AT ativo AR com `address_id` + vaga viva (`status='SEARCHING'`, `is_draft=false`, molde
 * `insertBaseVacancy`, `db-test-helper.ts:339`), com `job_postings.contracted_service_id` apontado
 * de volta para o serviço (o mesmo vínculo que `activateRecruitmentViaApi` produziria pela rota
 * real — aqui por SQL porque o insumo é só o serviço/vaga, não o funil de candidatura).
 */
export function seedServiceWithLiveVacancySql(patientId: string, addressId: string): ServiceWithVacancySeed {
  const caseNumber = Number(`${Date.now()}`.slice(-6));
  const serviceId = extractUuid(
    runSQL(
      `INSERT INTO patient_contracted_services (patient_id, address_id, service_code, active, country, created_by, updated_by) ` +
        `VALUES ('${patientId}', '${addressId}', 'AT', true, 'AR', 'e2e-itinerario-escrita-p24', 'e2e-itinerario-escrita-p24') ` +
        `RETURNING id`,
    ),
  );
  const vacancyId = insertBaseVacancy({
    patientId,
    patientAddressId: addressId,
    caseNumber,
    status: 'SEARCHING',
    isDraft: false,
  });
  runSQL(`UPDATE job_postings SET contracted_service_id = '${serviceId}' WHERE id = '${vacancyId}'`);
  return { serviceId, vacancyId };
}

// ── Limpeza ──────────────────────────────────────────────────────────────────────────

/**
 * Apaga o montado (`patient_itinerary_assembly`) e reusa `cleanupQuadroC` (marcas + alocações,
 * `quadro-c-e2e-helper.ts:147`) — por `patient_id`, nunca por título.
 */
export function cleanupItineraryWrite(patientId: string): void {
  if (!patientId) return;
  runSQL(`DELETE FROM patient_itinerary_assembly WHERE patient_id = '${patientId}'`);
  cleanupQuadroC(patientId);
}
