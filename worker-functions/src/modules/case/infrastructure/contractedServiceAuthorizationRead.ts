/**
 * Leitura da autorização CORRENTE de serviços contratados (spec 056 §5.1) — o ÚNICO SQL dela fora do repositório
 * da autorização, compartilhado por `PatientContractedServiceRepository.decorate` e `ContractedServiceDetailMapper`.
 * Corrente = `superseded_at IS NULL` e vigente em `CURRENT_DATE` (mesmo relógio de `horario_do_servico`).
 */
import { inclusiveValidToOf } from '../domain/ContractedServiceAuthorization';

export interface CurrentAuthorization {
  id: string;
  hours: number;
  validFrom: string;
  /** Inclusivo: último dia autorizado. */
  validTo: string;
}

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export const CURRENT_AUTHORIZATIONS_SQL = `
  SELECT contracted_service_id, id, hours::text AS hours,
         lower(valid)::text AS valid_from, upper(valid)::text AS valid_upper
    FROM contracted_service_authorization
   WHERE contracted_service_id = ANY($1::uuid[]) AND superseded_at IS NULL AND valid @> CURRENT_DATE`;

export function toCurrentAuthorizations(rows: any[]): Map<string, CurrentAuthorization> {
  return new Map(
    rows.map((r) => [
      r.contracted_service_id as string,
      { id: r.id, hours: Number(r.hours), validFrom: r.valid_from, validTo: inclusiveValidToOf(r.valid_upper) },
    ]),
  );
}

export async function fetchCurrentAuthorizations(q: Queryable, serviceIds: string[]): Promise<Map<string, CurrentAuthorization>> {
  if (serviceIds.length === 0) return new Map();
  const { rows } = await q.query(CURRENT_AUTHORIZATIONS_SQL, [serviceIds]);
  return toCurrentAuthorizations(rows ?? []);
}
