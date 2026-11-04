/**
 * Semente de PEDIDO de substituição (spec 069, migration 548). Desde a 548 o INSERT de
 * `patient_itinerary_absence` por SQL direto exige `request_id` (trg_patient_itinerary_absence_4_request):
 * o pedido existe, não está desfeito e é do MESMO serviço e do MESMO titular da alocação.
 *
 * Duas portas, as duas gravam o cabeçalho com INSERT simples (statement próprio, ANTES da ausência — um CTE
 * não serve: o gatilho da ausência não enxerga o INSERT do mesmo comando):
 *  - `seedRequestForAssignment`: deriva serviço e titular da alocação (o caso comum nos 058b/RLS/ausência);
 *  - `seedSubstitutionRequest`: serviço e titular explícitos (testes do próprio esquema 069).
 */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface SeedRequestOptions {
  /** `code` do catálogo `service_exit_reasons` (default `OTHER`, ativo desde a 492). */
  reasonCode?: string;
  createdBy?: string;
}

export interface SeedRequestInput extends SeedRequestOptions {
  serviceId: string;
  outgoingWorkerId: string;
}

export async function seedSubstitutionRequest(q: Queryable, input: SeedRequestInput): Promise<string> {
  const res = await q.query(
    `INSERT INTO patient_itinerary_substitution_request (contracted_service_id, outgoing_worker_id, reason_code, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.serviceId, input.outgoingWorkerId, input.reasonCode ?? 'OTHER', input.createdBy ?? 'e2e'],
  );
  return res.rows[0].id as string;
}

export async function seedRequestForAssignment(q: Queryable, assignmentId: string, opts: SeedRequestOptions = {}): Promise<string> {
  const a = await q.query(
    `SELECT s.contracted_service_id AS service_id, a.worker_id
       FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id
      WHERE a.id = $1`,
    [assignmentId],
  );
  if (a.rows.length === 0) throw new Error(`seedRequestForAssignment: alocação inexistente ${assignmentId}`);
  return seedSubstitutionRequest(q, { serviceId: a.rows[0].service_id, outgoingWorkerId: a.rows[0].worker_id, ...opts });
}
