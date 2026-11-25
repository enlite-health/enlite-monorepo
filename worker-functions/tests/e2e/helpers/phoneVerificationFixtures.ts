/**
 * Fixtures do PR-INF-47 (celular verificado, emenda 077). Banco REAL como `enlite_app`; dados sintéticos; nenhum canal real.
 * Telefone sintético ÚNICO por uso (idx_workers_phone_unique): um caso não colide com o outro.
 */
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';

type Db = Pool | PoolClient;
let seq = 0;

export const novoTelefone = (): string => `+54911${String(Date.now() % 100000).padStart(5, '0')}${String(seq++).padStart(3, '0')}`;

export async function novaFicha(
  db: Db,
  opts: { phone?: string | null; status?: string; email?: string } = {},
): Promise<{ id: string; phone: string | null }> {
  const phone = opts.phone === undefined ? novoTelefone() : opts.phone;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone, phone)
     VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires', $4) RETURNING id`,
    [`uid-pv-${randomUUID()}`, opts.email ?? `pv-${randomUUID()}@pv.test`, opts.status ?? 'INCOMPLETE_REGISTER', phone],
  );
  return { id: rows[0].id, phone };
}

/** Grava a prova de posse (o que o `confirm` fará): as 3 obrigatórias, mais o desafio quando houver. */
export async function gravarVerificacao(db: Db, workerId: string, challengeId: string | null = null): Promise<void> {
  await db.query(
    `UPDATE workers SET phone_verified_normalized = phone_normalized, phone_verified_at = now(),
            phone_verified_method = 'otp_whatsapp_template', phone_verified_otp_challenge_id = $2
      WHERE id = $1`,
    [workerId, challengeId],
  );
}

export async function novoDesafio(db: Db, workerId: string, phone: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO otp_challenges (id, worker_id, purpose, phone_e164, code_hmac, expires_at, status)
     VALUES ($1, $2, 'phone_verify', $3, 'aa', NOW() + INTERVAL '10 minutes', 'consumed')`,
    [id, workerId, phone],
  );
  return id;
}
