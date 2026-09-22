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
import { expect, type Locator } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from './db-test-helper';
import {
  psql, safeSql, scalar as scalarLocal, grantCell, ABAC_TENANT,
} from './abac-stack-helper';

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

/**
 * 🔒 Rodada 3/R3-F: staff MENCIONÁVEL na conversa de UM paciente — como `seedPlainStaff` (uid/
 * email/displayName livres, útil quando o teste faz asserção pelo NOME exibido), mas com grupo
 * próprio escopado a `country` (default 'AR', o mesmo país hardcoded de `seedPatientQA`) e a
 * célula `patient_conversation:read`. Desde a Rodada 3 (contrato R3-1), o popup de @ sempre manda
 * o `patientId` da conversa aberta — um staff sem esta célula/escopo NUNCA aparece nele, mesmo
 * que continue aparecendo no diretório CRU (sem `patientId`). Specs anteriores à Rodada 3 que
 * usavam `seedPlainStaff` para o alvo da menção precisam trocar para este helper (achado medido
 * ao reexecutar `mention-autocomplete-min-zero`/`mention-popup-clickup`/`patient-conversation-happy`
 * depois do wiring do `patientId` — ver `docs/.../tasks.md` "Rodada 3").
 */
export function seedMentionableStaff(
  uid: string, email: string, displayName: string, country = 'AR',
): { groupId: string } {
  psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
        VALUES ('${uid}', '${email}', '${displayName}', 'recruiter', true, 'ACTIVE', '${ABAC_TENANT}')`);
  const groupId = scalarLocal(`INSERT INTO iam.permission_groups (tenant_id, name, description)
        VALUES ('${ABAC_TENANT}', 'E2E Mencionavel ${uid}', 'e2e — nao mexer manual')
        RETURNING id`);
  psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
        VALUES ('${groupId}', '${country}', '${uid}', 'e2e setup')`);
  psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${uid}', '${groupId}', '${ABAC_TENANT}')`);
  grantCell(groupId, 'patient_conversation', 'read');
  return { groupId };
}

/**
 * Espera a transição CSS do `SlideOverPanel` terminar de verdade (P5, r2-card-3-linhas.png/
 * r2-painel-header.png tirados com o painel ainda no meio do `transition-transform duration-300`
 * — a classe `translate-x-0` já está no DOM no instante do clique, mas o `transform` computado só
 * chega em `matrix(1, 0, 0, 1, 0, 0)` 300ms depois). `expect.poll` no valor REAL de
 * `getComputedStyle`, nunca um `waitForTimeout` fixo — se a duração do CSS mudar, isto não quebra
 * nem mente sobre estar pronto antes da hora.
 */
export async function waitForSlideOverSettled(panel: Locator): Promise<void> {
  await expect.poll(async () => panel.evaluate((el) => getComputedStyle(el).transform)).toMatch(
    /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/,
  );
}
