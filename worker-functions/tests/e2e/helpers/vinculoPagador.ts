/**
 * vinculoPagador — fixture de BANCO REAL do portão `COVERAGE` (spec 087).
 *
 * Desde a 087 o portão de recrutamento (e o checklist) lê o VÍNCULO VIGENTE do serviço (`contracted_service_contract`), não mais
 * `patients.insurance_informed` nem `patient_insurance_verified`. Os e2e que só semeavam a informada para passar no portão
 * passam a vincular o serviço por aqui. Usa a obra social `PRIVATE` do catálogo (Particular conta como vínculo) e UM contrato fixo
 * por país (find-or-create: nada novo no catálogo a cada chamada, nada a limpar — o vínculo some junto com o serviço, ON DELETE CASCADE).
 */
import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;
export type PaisVinculo = 'AR' | 'BR';

/** Início distante no passado: o vínculo cobre qualquer "hoje" de operação. */
export const VIGENCIA_ABERTA = '[2020-01-01,)';

async function contratoParticular(db: Db, country: PaisVinculo): Promise<string> {
  const name = `QA087 vínculo particular ${country}`;
  await db.query(
    `INSERT INTO insurance_contracts (provider_code, country, name, created_by, updated_by)
     VALUES ('PRIVATE', $1, $2, 'qa087', 'qa087')
     ON CONFLICT (provider_code, lower(name)) DO NOTHING`,
    [country, name],
  );
  const r = await db.query<{ id: string }>(
    `SELECT id FROM insurance_contracts WHERE provider_code = 'PRIVATE' AND lower(name) = lower($1)`, [name],
  );
  return r.rows[0].id;
}

/** Vincula o serviço ao contrato Particular do país com a vigência dada (default: aberta desde 2020, cobre "hoje"). Devolve o id do vínculo. */
export async function vincularServicoAoPagador(
  db: Db, serviceId: string, country: PaisVinculo = 'AR', valid: string = VIGENCIA_ABERTA,
): Promise<string> {
  const contractId = await contratoParticular(db, country);
  const r = await db.query<{ id: string }>(
    `INSERT INTO contracted_service_contract (contracted_service_id, contract_id, valid, recorded_by)
     VALUES ($1, $2, $3::daterange, 'qa087') RETURNING id`,
    [serviceId, contractId, valid],
  );
  return r.rows[0].id;
}

/** Vincula TODOS os serviços ativos do paciente (os e2e de vários serviços não os listam um a um). */
export async function vincularServicosDoPaciente(db: Db, patientId: string, country: PaisVinculo = 'AR'): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM patient_contracted_services WHERE patient_id = $1 AND active
        AND NOT EXISTS (SELECT 1 FROM contracted_service_contract c WHERE c.contracted_service_id = patient_contracted_services.id AND c.superseded_at IS NULL)`,
    [patientId],
  );
  const out: string[] = [];
  for (const s of rows) out.push(await vincularServicoAoPagador(db, s.id, country));
  return out;
}
