import type { Pool, PoolClient } from 'pg';
import { TENANT_E2E } from './permissionFamilyHarness';

/**
 * interviewHostFixture — ÚNICO jeito de semear `interview_hosts` nos e2e (spec 055).
 *
 * Desde a migration 523 a leitura de agendamento faz JOIN em `users` (staff ativo), então uma linha sem usuário some do roster; e
 * `countries` é NOT NULL. Por isso toda fixture de entrevistadora cria (ou reaproveita, por e-mail) o usuário staff e grava a linha
 * com `user_uid`, `countries` e os dois fluxos ligados — o comportamento de antes da spec. Não repetir esse SQL nos testes.
 *
 * Limpeza: os testes continuam apagando as linhas de `interview_hosts` por e-mail; o usuário semeado fica (idempotente por e-mail,
 * uid `ihost-<e-mail>`), ou é apagado pelo dono quando o teste passa `uid` próprio.
 */
type Db = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface InterviewHostFixture {
  email: string;
  displayName?: string;
  /** Países que atende. Padrão `[country]`. */
  countries?: string[];
  /** Coluna legada `country` (NOT NULL). Padrão: 1º de `countries` ou 'AR'. */
  country?: string;
  active?: boolean;
  doesEnquadre?: boolean;
  doesAdmission?: boolean;
  /** `false` = linha SEM usuário (`user_uid` NULL), como a Ana Joulie em prd. Padrão `true`. */
  withUser?: boolean;
  /** `false` = o usuário existe mas está desativado. Padrão `true`. */
  userActive?: boolean;
  /** uid do usuário; padrão `ihost-<e-mail>`. Se o e-mail já tem usuário, vale o que existe. */
  uid?: string;
}

export async function insertInterviewHost(db: Db, h: InterviewHostFixture): Promise<{ id: string; uid: string | null }> {
  const countries = h.countries ?? [h.country ?? 'AR'];
  let uid: string | null = null;
  if (h.withUser !== false) {
    const { rows } = await db.query<{ firebase_uid: string }>(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id)
       VALUES ($1, $2, $3, 'admin', 'ACTIVE', $4, $5)
       ON CONFLICT (email) DO UPDATE SET is_active = EXCLUDED.is_active
       RETURNING firebase_uid`,
      [h.uid ?? `ihost-${h.email}`, h.email, h.displayName ?? h.email, h.userActive !== false, TENANT_E2E],
    );
    uid = rows[0].firebase_uid;
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO interview_hosts (email, display_name, country, countries, user_uid, does_enquadre, does_admission, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [h.email, h.displayName ?? null, countries[0], countries, uid, h.doesEnquadre !== false, h.doesAdmission !== false, h.active !== false],
  );
  return { id: rows[0].id, uid };
}

/** Apaga as linhas (todas, ou só dos e-mails) e os usuários que ESTA fixture criou (`ihost-*`) e que ninguém mais referencia. */
export async function deleteInterviewHosts(db: Db, emails?: string[]): Promise<void> {
  if (emails) await db.query('DELETE FROM interview_hosts WHERE email = ANY($1)', [emails]);
  else await db.query('DELETE FROM interview_hosts');
  await db.query(
    `DELETE FROM users u WHERE u.firebase_uid LIKE 'ihost-%' AND NOT EXISTS (SELECT 1 FROM interview_hosts h WHERE h.user_uid = u.firebase_uid)`,
  );
}
