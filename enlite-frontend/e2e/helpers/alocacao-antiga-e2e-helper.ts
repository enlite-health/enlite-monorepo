/**
 * alocacao-antiga-e2e-helper.ts
 *
 * Helpers do e2e da alocação ANTIGA (a tabela da migration 319, anterior ao itinerário) — Fase 14,
 * change cadeia-paciente-vacante-itinerario, P17 (DX-14.15). Desde a Fase 14 nenhuma rota escreve
 * nessa tabela: a linha antiga só nasce por SQL como dono (é como as linhas de produção existem), e
 * as duas rotas antigas (`POST/PATCH …/contracted-services/:sid/providers[/:pid]`) são chamadas cruas
 * só para provar que devolvem 404.
 *
 * Reusa sem copiar: `backendUrl()` (`lancamento-e2e-helper.ts:32`, mesmo fallback do CI dos irmãos,
 * lida DENTRO das funções — nunca no topo do módulo, o Playwright carrega todos os specs antes do
 * `--grep`), `runSQL` (`patient-detail-a-helper.ts:9`), `extractUuid` (`itinerario-escrita-e2e-helper.ts:171`).
 * Nenhum host/porta literal, nenhum `throw` no import, nenhum preenchimento programático de campo.
 *
 * Limpeza: `cleanupLegacyAllocations` sai ANTES de `cleanupTestWorker` — o `worker_id` da tabela
 * antiga não tem `ON DELETE` (319:175); apagar o worker primeiro aborta com 23503.
 */
import { type APIRequestContext } from '@playwright/test';
import { backendUrl } from './lancamento-e2e-helper';
import { runSQL } from './patient-detail-a-helper';
import { extractUuid } from './itinerario-escrita-e2e-helper';

/** Autor sintético da semente (`created_by`/`updated_by` são NOT NULL). */
const LEGACY_SEED_AUTHOR = 'e2e-f14';

/**
 * Semeia 1 linha antiga ativa (o `country` vem do trigger da 319). Devolve o id da linha.
 */
export function seedLegacyAllocationSql(serviceId: string, workerId: string, weeklyHours: number): string {
  return extractUuid(
    runSQL(
      `INSERT INTO contracted_service_providers (service_id, worker_id, weekly_hours, created_by, updated_by) ` +
        `VALUES ('${serviceId}', '${workerId}', ${Number(weeklyHours)}, '${LEGACY_SEED_AUTHOR}', '${LEGACY_SEED_AUTHOR}') ` +
        `RETURNING id`,
    ),
  );
}

/** Quantas linhas antigas (ativas ou não) o serviço tem. */
export function countLegacyAllocations(serviceId: string): number {
  return Number(runSQL(`SELECT count(*) FROM contracted_service_providers WHERE service_id = '${serviceId}'`));
}

/** Apaga as linhas antigas do serviço — por `service_id`, antes do worker. */
export function cleanupLegacyAllocations(serviceId: string): void {
  if (!serviceId) return;
  runSQL(`DELETE FROM contracted_service_providers WHERE service_id = '${serviceId}'`);
}

export interface LegacyProviderApiResult {
  status: number;
}

/** `POST /patients/:id/contracted-services/:sid/providers` cru — só o status (esperado: 404). */
export async function postLegacyProviderApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
  workerId: string,
): Promise<LegacyProviderApiResult> {
  const res = await request.post(
    `${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/providers`,
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { workerId, weeklyHours: 10 },
      failOnStatusCode: false,
    },
  );
  return { status: res.status() };
}

/** `PATCH /patients/:id/contracted-services/:sid/providers/:pid` cru — só o status (esperado: 404). */
export async function patchLegacyProviderApi(
  request: APIRequestContext,
  token: string,
  patientId: string,
  serviceId: string,
  providerId: string,
): Promise<LegacyProviderApiResult> {
  const res = await request.patch(
    `${backendUrl()}/api/admin/patients/${patientId}/contracted-services/${serviceId}/providers/${providerId}`,
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { active: false },
      failOnStatusCode: false,
    },
  );
  return { status: res.status() };
}
