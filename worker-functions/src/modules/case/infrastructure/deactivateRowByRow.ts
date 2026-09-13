import type { PoolClient } from 'pg';

/**
 * Resultado de "desativar 1 linha" — o controller mapeia para 404 (`not_found`), 409
 * (`already_inactive`) ou 200 (`deactivated`). Nunca DELETE (spec 018, PR-1, ADR-1, FR-002).
 * `emergencyMarkCleared` só é preenchido quando `table` tem coluna de marca associada
 * (`emergencyMarkColumn` abaixo) — migration 423, spec 018 PR-2, D-A #4.
 */
export type DeactivateOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'already_inactive' }
  | { outcome: 'deactivated'; id: string; emergencyMarkCleared?: boolean };

const EMERGENCY_MARK_COLUMN = {
  patient_responsibles: 'emergency_responsible_id',
  patient_external_contacts: 'emergency_external_contact_id',
  patient_coverage_emergency_contacts: null,
  patient_professionals: null,
} as const;

/**
 * Desativa (nunca DELETE) UMA linha de uma tabela por-linha do spec 018/PR-1/PR-2 — achado do
 * gate `revisao-pr` (critério 2: duplicação dentro do diff): `PatientResponsibleRepository.deactivate`
 * e `PatientCoverageEmergencyContactRepository.deactivate` eram idênticos linha a linha, e
 * `DeactivateOutcome`/`CoverageContactDeactivateOutcome` eram a MESMA união com dois nomes. O
 * `SELECT … FOR UPDATE` (decide 404×409 antes do UPDATE) + o UPDATE moram aqui uma vez só.
 *
 * `table` é sempre um LITERAL do próprio código (nunca entrada do usuário/request) — a
 * interpolação não abre superfície nova de SQL injection.
 *
 * `emergencyMarkCleared` (D-A #4, migration 423): para `patient_responsibles` e
 * `patient_external_contacts`, o trigger `..._desativa_limpa_marca` já limpa
 * `patients.emergency_*` NA MESMA TRANSAÇÃO quando a linha desativada era a marcada — aqui só
 * CONSTATAMOS isso (SELECT no `patients` ANTES do UPDATE, comparando com o id) para o controller
 * poder responder `{emergencyMarkCleared: boolean}` sem uma segunda ida ao banco depois.
 */
export async function deactivateRow(
  client: PoolClient,
  table: keyof typeof EMERGENCY_MARK_COLUMN,
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

  const markColumn = EMERGENCY_MARK_COLUMN[table];
  let wasMarked = false;
  if (markColumn) {
    const { rows: markRows } = await client.query<{ marked: boolean }>(
      `SELECT (${markColumn} = $2) AS marked FROM patients WHERE id = $1`,
      [patientId, id],
    );
    wasMarked = markRows[0]?.marked ?? false;
  }

  await client.query(
    `UPDATE ${table} SET active = false, deactivated_at = NOW(), deactivated_by = $3
      WHERE id = $2 AND patient_id = $1`,
    [patientId, id, actorUid],
  );
  return markColumn ? { outcome: 'deactivated', id, emergencyMarkCleared: wasMarked } : { outcome: 'deactivated', id };
}
