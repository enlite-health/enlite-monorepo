/**
 * contrato058aApi — cliente HTTP e atores das suítes `058a-*.e2e.test.ts` (spec 058, Parte A) que falam com a API REAL (sem mock).
 * Admin AR e recrutadora AR no mock auth (ou no emulador, se estiver de pé — `staffAuth` sonda). Com o engine ABAC desligado (CI e p058a), as rotas de
 * célula nova valem `untilEnforced: 'admin'`: o admin passa e a recrutadora leva 403.
 */
import { createApiClient, waitForBackend } from '../helpers';
import { staffAuth, type StaffAuth } from './staffAuth';

export const api = createApiClient();

export async function atores(): Promise<{ admin: StaffAuth; recrutadora: StaffAuth }> {
  await waitForBackend(api);
  return {
    admin: await staffAuth('qa058a-admin', 'admin', 'AR'),
    recrutadora: await staffAuth('qa058a-recruiter', 'recruiter', 'AR'),
  };
}

/** Valor único por execução (códigos de pagador/nome de contrato nunca colidem com rodada anterior). */
let n = 0;
export const sufixo = (): string => `${Date.now().toString(36)}${(n++).toString(36)}`.toUpperCase();

export const BASE = '/api/admin';

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

const TENANT = '00000000-0000-0000-0000-000000000001';
const PREFIXO_GRUPO = 'QA058 e2e ';

/**
 * Dá ao `uid` um grupo vivo com escopo dos `countries` (é daí que `iam.effective_countries` — e portanto `resolveCountryScope` — lê o país
 * do ator; o mock auth NÃO cria grupo). Cada grant leva `granted_by` (o piso do consolidado multi-país). Devolve a limpeza.
 */
export async function concederPaises(pool: Pool, uid: string, countries: string[]): Promise<() => Promise<void>> {
  const groupId = randomUUID();
  // O usuário também é nosso: staff ACTIVE sem grupo vivo reprova a pré-condição do F12 (iam-config-export-import) em suítes que rodam DEPOIS —
  // então a limpeza apaga o que ESTA chamada criou (um usuário que já existia não é tocado).
  const criou = (await pool.query(
    `INSERT INTO users (firebase_uid, email, role, tenant_id) VALUES ($1, $2, 'admin', $3) ON CONFLICT (firebase_uid) DO NOTHING`,
    [uid, `${uid}@e2e.local`, TENANT],
  )).rowCount === 1;
  await pool.query(`INSERT INTO permission_groups (id, tenant_id, name) VALUES ($1, $2, $3)`, [groupId, TENANT, `${PREFIXO_GRUPO}${uid} ${countries.join('+')}`]);
  await pool.query(`INSERT INTO user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [uid, groupId, TENANT]);
  for (const country of countries) {
    await pool.query(`INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason) VALUES ($1, $2, $3, 'qa058a', 'e2e 058a')`, [randomUUID(), groupId, country]);
  }
  return async () => {
    await pool.query(`DELETE FROM group_country_scopes WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM user_groups WHERE group_id = $1`, [groupId]);
    await pool.query(`DELETE FROM permission_groups WHERE id = $1`, [groupId]);
    if (criou) await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [uid]);
  };
}
