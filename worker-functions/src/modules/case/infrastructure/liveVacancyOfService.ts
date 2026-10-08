import type { Pool, PoolClient } from 'pg';
import { VACANCY_CASE_NUMBER_SQL } from '@shared/sql/vacancyCaseNumberSql';

/**
 * A vaga VIVA de um serviço contratado, como a ficha a mostra (spec 047, F2): o suficiente para o
 * código (`EN1234#01`) e o estado — e NADA mais (nenhum campo de dinheiro).
 *
 * UM dono só: o mapper da ficha (`GET /patients/:id`) e o repositório do serviço
 * (`/contracted-services`) leem por aqui, então as duas rotas devolvem o MESMO objeto.
 * Leitura pura do banco; este caminho NUNCA chama o Short.io nem lê `social_short_links` (o link do site
 * saiu da ficha a pedido do Gabriel, 08/10: em PRD o valor é um objeto `{id,url}`, não string).
 */
export interface LiveVacancy {
  id: string;
  /** Caso efetivo do paciente (fragmento com dono, spec 046) — null = vaga sem paciente visível. */
  caseNumber: number | null;
  /** Ordinal da vaga dentro do caso (migration 460) — null = vaga legada. */
  caseOrdinal: number | null;
  status: string | null;
}

/**
 * Predicado de "viva" = o MESMO do 409 de `ActivateRecruitmentUseCase` (`contracted_service_id` e
 * `deleted_at IS NULL`); com mais de uma, vale a mais ANTIGA (`created_at ASC`).
 */
export async function fetchLiveVacancies(cli: Pool | PoolClient, serviceIds: string[]): Promise<Map<string, LiveVacancy>> {
  if (serviceIds.length === 0) return new Map();
  const { rows } = await cli.query<{
    contracted_service_id: string;
    id: string;
    case_number: number | null;
    case_ordinal: number | null;
    status: string | null;
  }>(
    `SELECT DISTINCT ON (jp.contracted_service_id)
            jp.contracted_service_id, jp.id, ${VACANCY_CASE_NUMBER_SQL} AS case_number, jp.case_ordinal, jp.status
       FROM job_postings jp
       LEFT JOIN patients p ON p.id = jp.patient_id
      WHERE jp.contracted_service_id = ANY($1::uuid[]) AND jp.deleted_at IS NULL
      ORDER BY jp.contracted_service_id, jp.created_at ASC`,
    [serviceIds],
  );
  return new Map(
    rows.map((r) => [
      r.contracted_service_id,
      {
        id: r.id,
        caseNumber: r.case_number ?? null,
        caseOrdinal: r.case_ordinal ?? null,
        status: r.status ?? null,
      },
    ]),
  );
}
