/**
 * providerPatientsRead (§L) — os pacientes com vínculo VIGENTE a uma obra social (spec 058 §3.2 §L, plan §1.2). Portão da rota:
 * `insurance_provider_patients:read`. A data é POR LINHA: `($asOfByCountry ->> pcs.country)::date`, porque "hoje" é o do país do
 * serviço (Buenos Aires != São Paulo) — o mapa vem de `buildAsOfByCountry` (um `requestNow` por requisição). País fora do mapa não casa
 * (é o recorte de escopo do chamador), `items: []` = nenhum vínculo vigente e erro de banco é erro (sem `catch` que devolva `[]`).
 *
 * O item NÃO carrega campo de nenhum container de paciente (sem nome, endereço, cobertura nem preço): só ids, nº do caso, nome do
 * contrato e a vigência (wire, `validTo` inclusivo). Roda dentro de `withActorContext` (a RLS de `patients`/`pcs` exige o país da sessão).
 */
import { toWire } from '../domain/dateRangeWire';
import type { Queryable } from './insuranceContractTermRead';

export interface ProviderPatientItem {
  patientId: string;
  caseNumber: number | null;
  contractedServiceId: string;
  contractName: string;
  validFrom: string;
  validTo: string | null;
  asOf: string;
}

interface Row {
  patient_id: string;
  case_number: string | number | null;
  contracted_service_id: string;
  contract_name: string;
  valid: string;
  country: string;
}

export async function providerPatientsRead(q: Queryable, providerCode: string, asOfByCountry: Readonly<Record<string, string>>): Promise<ProviderPatientItem[]> {
  const { rows } = await q.query<Row>(
    `SELECT p.id AS patient_id,
            COALESCE(p.case_number, (SELECT MAX(jp.case_number) FROM job_postings jp WHERE jp.patient_id = p.id AND jp.deleted_at IS NULL)) AS case_number,
            pcs.id AS contracted_service_id, c.name AS contract_name, csc.valid::text AS valid, pcs.country
       FROM contracted_service_contract csc
       JOIN insurance_contracts c ON c.id = csc.contract_id AND c.provider_code = $1
       JOIN patient_contracted_services pcs ON pcs.id = csc.contracted_service_id
       JOIN patients p ON p.id = pcs.patient_id
      WHERE csc.superseded_at IS NULL AND csc.valid @> ($2::jsonb ->> pcs.country)::date
      ORDER BY c.name, p.id, pcs.id`,
    [providerCode, JSON.stringify(asOfByCountry)],
  );
  return rows.map((r) => {
    const w = toWire(r.valid);
    return {
      patientId: r.patient_id,
      caseNumber: r.case_number === null ? null : Number(r.case_number),
      contractedServiceId: r.contracted_service_id,
      contractName: r.contract_name,
      validFrom: w.validFrom,
      validTo: w.validTo,
      asOf: asOfByCountry[r.country],
    };
  });
}
