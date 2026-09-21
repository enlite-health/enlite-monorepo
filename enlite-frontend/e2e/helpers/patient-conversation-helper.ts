/**
 * patient-conversation-helper.ts — seed/cleanup específico dos e2e Playwright do Bloco 2 da spec
 * 022 (T218-T221). NÃO duplica infraestrutura: reaproveita `db-test-helper.ts` (paciente, via
 * `docker exec $E2E_PG_CONTAINER`) e `abac-stack-helper.ts` (staff/grupo/célula/login humano, via
 * `ABAC_API_URL`/`ABAC_TEST_DB_URL` — psql direto, mesmo stack isolado). Os specs deste bloco
 * exportam as env vars apontando para o stack próprio desta sessão (Postgres `enlite-pg-022b2`
 * porta 5442, API porta 8092) — ver docblock de cada spec.
 *
 * Sem PII/texto clínico: paciente é sempre "Paciente QA", staff "QA Staff <N>", corpo "msg-1".
 */
import { insertTestPatient, cleanupTestPatient } from './db-test-helper';
import { psql, safeSql, ABAC_TENANT } from './abac-stack-helper';

export { grantCell, seedStaffInGroup, cleanupStaffAndGroup, loginAs, tokenFor, installAuthInterceptors, psql, scalar, safeSql, meAuthz, ABAC_API_URL, ABAC_DB_URL, ABAC_TENANT } from './abac-stack-helper';
export type { MockUser } from './abac-stack-helper';

/** Paciente sintético "Paciente QA" — status ACTIVE (a conversa não depende de status de admissão). */
export function seedPatientQA(): string {
  const { patientId } = insertTestPatient({ status: 'ACTIVE', firstName: 'Paciente', lastName: 'QA' });
  return patientId;
}

export function cleanupPatientQA(patientId: string): void {
  cleanupTestPatient(patientId);
}

/**
 * Staff ATIVO sem grupo nenhum (não passa por `seedStaffInGroup`, que sempre cria grupo) — serve
 * tanto para o "2º ator a mencionar" (T218) quanto para o cenário "sem célula" (T219).
 */
export function seedPlainStaff(uid: string, email: string, displayName: string): void {
  psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
        VALUES ('${uid}', '${email}', '${displayName}', 'recruiter', true, 'ACTIVE', '${ABAC_TENANT}')`);
}

export function cleanupPlainStaff(uid: string): void {
  safeSql(`DELETE FROM users WHERE firebase_uid = '${uid}'`);
}
