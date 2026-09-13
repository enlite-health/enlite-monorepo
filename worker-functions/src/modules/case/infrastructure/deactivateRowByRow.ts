import type { PoolClient } from 'pg';

/**
 * Resultado de "desativar 1 linha" — o controller mapeia para 404 (`not_found`), 409
 * (`already_inactive`) ou 200 (`deactivated`). Nunca DELETE (spec 018, PR-1, ADR-1, FR-002).
 */
export type DeactivateOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'already_inactive' }
  | { outcome: 'deactivated'; id: string };

/**
 * Desativa (nunca DELETE) UMA linha de uma tabela por-linha do spec 018/PR-1 — achado do gate
 * `revisao-pr` (critério 2: duplicação dentro do diff): `PatientResponsibleRepository.deactivate`
 * e `PatientCoverageEmergencyContactRepository.deactivate` eram idênticos linha a linha, e
 * `DeactivateOutcome`/`CoverageContactDeactivateOutcome` eram a MESMA união com dois nomes. O
 * `SELECT … FOR UPDATE` (decide 404×409 antes do UPDATE) + o UPDATE moram aqui uma vez só.
 *
 * `table` é sempre um LITERAL do próprio código (nunca entrada do usuário/request) — a
 * interpolação não abre superfície nova de SQL injection.
 */
export async function deactivateRow(
  client: PoolClient,
  table: 'patient_responsibles' | 'patient_coverage_emergency_contacts' | 'patient_professionals',
  patientId: string,
  id: string,
  actorUid: string,
): Promise<DeactivateOutcome> {
  const { rows } = await client.query<{ id: string; active: boolean }>(
    `SELECT id, active FROM ${table} WHERE id = $2 AND patient_id = $1 FOR UPDATE`,
    [patientId, id],
  );
  if (!rows[0]) return { outcome: 'not_found' };
  if (!rows[0].active) return { outcome: 'already_inactive' };
  await client.query(
    `UPDATE ${table} SET active = false, deactivated_at = NOW(), deactivated_by = $3
      WHERE id = $2 AND patient_id = $1`,
    [patientId, id, actorUid],
  );
  return { outcome: 'deactivated', id };
}
