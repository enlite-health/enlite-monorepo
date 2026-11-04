/**
 * Leitura da autorização CORRENTE de serviços contratados (spec 056 §5.1) — o ÚNICO SQL dela fora do repositório
 * da autorização, compartilhado por `PatientContractedServiceRepository.decorate` e `ContractedServiceDetailMapper`.
 * Corrente = `superseded_at IS NULL` e vigente em `asOf` (o dia de operação do país do serviço, que o CHAMADOR calcula: nunca o relógio do banco).
 */
import { toWire } from '../domain/dateRangeWire';

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

const CURRENT_AUTHORIZATIONS_SQL = `
  SELECT contracted_service_id, id, hours::text AS hours, valid::text AS valid
    FROM contracted_service_authorization
   WHERE contracted_service_id = ANY($1::uuid[]) AND superseded_at IS NULL AND valid @> $2::date`;

export function toCurrentAuthorizations(rows: any[]): Map<string, CurrentAuthorization> {
  return new Map(
    rows.map((r): [string, CurrentAuthorization] => {
      const wire = toWire(r.valid as string);
      // `csa_valid_fechada` (529) garante vigência fechada: `validTo` nunca é null aqui.
      return [r.contracted_service_id as string, { id: r.id, hours: Number(r.hours), validFrom: wire.validFrom, validTo: wire.validTo as string }];
    }),
  );
}

export async function fetchCurrentAuthorizations(q: Queryable, serviceIds: string[], asOf: string): Promise<Map<string, CurrentAuthorization>> {
  if (serviceIds.length === 0) return new Map();
  const { rows } = await q.query(CURRENT_AUTHORIZATIONS_SQL, [serviceIds, asOf]);
  return toCurrentAuthorizations(rows ?? []);
}
