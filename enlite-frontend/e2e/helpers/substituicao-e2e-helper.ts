/**
 * substituicao-e2e-helper.ts
 *
 * Helpers do e2e da substituição pontual (Fase 13, change cadeia-paciente-vacante-itinerario,
 * P34 — DX-13.15, insumo das DX-13.3 a 13.15): as 3 rotas novas da ausência
 * (`CASE/interfaces/routes/adminItineraryWriteRoutes.ts`, DX-13.8 — ainda sendo fechadas em
 * `worker-functions/` por outro agente nesta sessão, não tocado aqui) cruas, sem `expect` — o
 * teste decide o esperado (feliz e os 400/404/409/422). Mais as datas de teste por DATA-F13
 * (sempre do banco, Buenos Aires), a semente por SQL da ausência PASSADA (a API a recusa por
 * desenho, DX-13.7) e a limpeza do que esta fase grava.
 *
 * Reusa sem copiar: `backendUrl()` (`lancamento-e2e-helper.ts:32-34`, mesmo fallback do CI dos
 * irmãos, lida DENTRO das funções — nunca no topo do módulo, o Playwright carrega todos os specs
 * antes do `--grep`), `runSQL` (`patient-detail-a-helper.ts:9`), `extractUuid`
 * (`itinerario-escrita-e2e-helper.ts:171`), `openContractedServiceTab`/`selectServiceRow`
 * (`quadro-c-e2e-helper.ts:111,128`), `cleanupItineraryWrite` (`itinerario-escrita-e2e-helper.ts:259`).
 * Nenhum host/porta literal, nenhum `throw` no import, nenhum `fill()`, nenhuma conta de data no
 * relógio do processo — sempre lida do Postgres (DATA-F13).
 */
import { type APIRequestContext, type Page } from '@playwright/test';
import { backendUrl } from './lancamento-e2e-helper';
import { runSQL } from './patient-detail-a-helper';
import { extractUuid, cleanupItineraryWrite } from './itinerario-escrita-e2e-helper';
import { openContractedServiceTab, selectServiceRow } from './quadro-c-e2e-helper';

export interface AbsenceApiResult<T = unknown> {
  status: number;
  body: { success: boolean; data?: T; error?: string; code?: string; [k: string]: unknown };
}

/** Espelha o `status` de `ItineraryAbsenceWriter`/`ItineraryAbsenceUseCase` (DX-13.7) — pacote diferente, não importa de lá. */
export type AbsenceStatus = 'OPEN' | 'CANCELLED';

export interface AbsenceDto {
  absenceId: string;
  allocationId: string;
  date: string;
  substituteWorkerId: string | null;
  status: AbsenceStatus;
}

/** Corpo CRU — o teste decide o que manda (inclusive payload incompleto/chave ausente, para os 400/422). */
export type AbsenceWriteBody = Record<string, unknown>;

// ── As 3 rotas da ausência (DX-13.8) ────────────────────────────────────────────────

/**
 * `POST /patients/:id/contracted-services/:sid/itinerary/allocations/:allocationId/absences` (201).
 * Devolve `{ status, body }` cru — nenhum `expect`, quem decide é o teste.
 */
export async function registerAbsenceApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
  allocationId: string,
  body: AbsenceWriteBody,
): Promise<AbsenceApiResult<AbsenceDto>> {
  const res = await request.post(
    `${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/allocations/${allocationId}/absences`,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, data: body },
  );
  const status = res.status();
  const responseBody = (await res.json().catch(() => ({ success: false }))) as AbsenceApiResult<AbsenceDto>['body'];
  return { status, body: responseBody };
}

/**
 * `PATCH /patients/:id/contracted-services/:sid/itinerary/absences/:absenceId/substitute` (200).
 * `substituteWorkerId: null` EXPLÍCITO tira o substituto; corpo sem a chave é o que o teste manda
 * para provar o 400 (memória `vazio-ambiguo-nao-e-informacao-de-ausencia`, DX-13.8).
 */
export async function setAbsenceSubstituteApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
  absenceId: string,
  body: AbsenceWriteBody,
): Promise<AbsenceApiResult<AbsenceDto>> {
  const res = await request.patch(
    `${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/absences/${absenceId}/substitute`,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, data: body },
  );
  const status = res.status();
  const responseBody = (await res.json().catch(() => ({ success: false }))) as AbsenceApiResult<AbsenceDto>['body'];
  return { status, body: responseBody };
}

/** `POST /patients/:id/contracted-services/:sid/itinerary/absences/:absenceId/cancel` (200) — sem corpo. */
export async function cancelAbsenceApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
  absenceId: string,
): Promise<AbsenceApiResult<AbsenceDto>> {
  const res = await request.post(
    `${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/absences/${absenceId}/cancel`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const status = res.status();
  const responseBody = (await res.json().catch(() => ({ success: false }))) as AbsenceApiResult<AbsenceDto>['body'];
  return { status, body: responseBody };
}

// ── Datas de teste, SEMPRE do banco (DATA-F13) ──────────────────────────────────────

/**
 * Próxima ocorrência ESTRITAMENTE FUTURA do dia da semana `dow` (Buenos Aires; `dow` na
 * convenção Postgres do `extract(dow FROM …)`, 1 = segunda = o mesmo `dayOfWeek` 1 do
 * `schedule`, `lancamento-e2e-helper.ts:317`) — lida do banco, nunca do relógio do runner.
 */
export function nextWeekdaySql(dow: number): string {
  return runSQL(
    `SELECT to_char(g::date,'YYYY-MM-DD') FROM (SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS t) x, ` +
      `generate_series(x.t + 1, x.t + 7, interval '1 day') g WHERE extract(dow FROM g) = ${dow}`,
  );
}

/** A ocorrência PASSADA mais recente do dia da semana `dow` (Buenos Aires), lida do banco. */
export function pastWeekdaySql(dow: number): string {
  return runSQL(
    `SELECT to_char(g::date,'YYYY-MM-DD') FROM (SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS t) x, ` +
      `generate_series(x.t - 7, x.t - 1, interval '1 day') g WHERE extract(dow FROM g) = ${dow}`,
  );
}

// ── Semente por SQL (a única escrita fora da API nova, DX-7.6/13.15) ────────────────

/**
 * Semeia a ausência em data PASSADA direto em `patient_itinerary_absence` (critério 10) — a API
 * a recusa por desenho (`AbsenceDateInPastError`, DX-13.7); os gatilhos da migration 484 validam
 * igual. `date` vem de `pastWeekdaySql`, nunca do relógio do runner. Sem substituto (o CHECK
 * `(substitute_worker_id IS NULL) = (substitute_application_id IS NULL)` aceita os dois NULL).
 */
export function insertPastAbsenceSql(allocationId: string, date: string): string {
  return extractUuid(
    runSQL(
      `INSERT INTO patient_itinerary_absence (assignment_id, on_date, created_by, updated_by) ` +
        `VALUES ('${allocationId}', '${date}'::date, 'e2e-substituicao-p34', 'e2e-substituicao-p34') RETURNING id`,
    ),
  );
}

/** Conta ausências OPEN (`cancelled_at IS NULL`) da alocação — insumo do critério de "1 aberta por vez". */
export function countOpenAbsences(allocationId: string): number {
  return Number(
    runSQL(
      `SELECT count(*) FROM patient_itinerary_absence WHERE assignment_id = '${allocationId}' AND cancelled_at IS NULL`,
    ),
  );
}

// ── Tela: quadro C do serviço ────────────────────────────────────────────────────────

/**
 * Ficha do paciente → aba "Servicio Contratado" → linha do serviço — composição de
 * `openContractedServiceTab` + `selectServiceRow` (`quadro-c-e2e-helper.ts:111,128`), não cópia.
 */
export async function openServiceTeamOf(page: Page, patientId: string, serviceId: string): Promise<void> {
  await openContractedServiceTab(page, patientId);
  await selectServiceRow(page, serviceId);
}

// ── Limpeza ──────────────────────────────────────────────────────────────────────────

/**
 * Apaga `patient_itinerary_absence` do paciente (por `assignment_id` das alocações dos slots dos
 * serviços dele, molde `cleanupItinerary`, `itinerario-e2e-helper.ts:191-199`) e reusa
 * `cleanupItineraryWrite` (marcas + itinerário + montado, `itinerario-escrita-e2e-helper.ts:259`)
 * — por `patient_id`, nunca por título. Sai ANTES na ordem do chamador (regra 13 do brief:
 * ausência → alocação → marcas → montado → WJA/vaga → worker → serviço → paciente).
 */
export function cleanupSubstituicao(patientId: string): void {
  if (!patientId) return;
  runSQL(
    `DELETE FROM patient_itinerary_absence WHERE assignment_id IN (` +
      `SELECT pia.id FROM patient_itinerary_assignment pia ` +
      `JOIN patient_itinerary_slot pis ON pis.id = pia.slot_id ` +
      `JOIN patient_contracted_services pcs ON pcs.id = pis.contracted_service_id ` +
      `WHERE pcs.patient_id = '${patientId}')`,
  );
  cleanupItineraryWrite(patientId);
}
