import type { Pool } from 'pg';
import type {
  IPhoneVerificationRepository,
  MarkPhoneVerifiedInput,
  PhoneVerificationMethod,
  PhoneVerificationReadModel,
  PhoneVerificationState,
  SqlRunner,
} from '@modules/auth/ports/IPhoneVerificationRepository';

const PG_UNIQUE_VIOLATION = '23505';
const PHONE_UNIQUE_INDEXES = new Set(['idx_workers_phone_unique', 'uq_workers_phone_verified_now', 'uq_workers_phone_verified_otp_challenge']);

/**
 * Único repositório que lê e grava `workers.phone_verified_*` no fluxo do celular verificado (AC-13). O estado sai SEMPRE da
 * função derivada do banco; aqui não existe regra própria de "verificado".
 */
export class PgPhoneVerificationRepository implements IPhoneVerificationRepository {
  constructor(private readonly pool: Pool) {}

  async readState(workerId: string): Promise<PhoneVerificationReadModel | null> {
    const { rows } = await this.pool.query<{ state: PhoneVerificationState; phone: string | null; verified_at: Date | null }>(
      `SELECT public.fn_worker_phone_verification_state(w.id) AS state,
              w.phone,
              CASE WHEN public.fn_worker_phone_is_verified(w) THEN w.phone_verified_at END AS verified_at
         FROM workers w WHERE w.id = $1`,
      [workerId],
    );
    const row = rows[0];
    if (!row) return null;
    return { state: row.state, phone: row.phone, verifiedAt: row.state === 'verified' ? row.verified_at : null };
  }

  async markPhoneVerified(db: SqlRunner, input: MarkPhoneVerifiedInput): Promise<'ok' | 'PHONE_IN_USE'> {
    let res: Awaited<ReturnType<SqlRunner['query']>>;
    try {
      res = await db.query(
      `UPDATE workers
          SET phone = COALESCE($2, phone),
              phone_verified_normalized = public.normalize_phone_ar(COALESCE($2, phone)),
              phone_verified_at = now(),
              phone_verified_method = $3,
              phone_verified_otp_challenge_id = $4
        WHERE id = $1 AND merged_into_id IS NULL AND COALESCE($2, phone) IS NOT NULL`,
      [input.workerId, input.phoneNormalized ?? null, input.method, input.challengeId],
      );
    } catch (err: unknown) {
      // DT-51: a mensagem do Postgres ecoa a linha (PII): só o código e o nome do índice decidem; nada disso sobe como mensagem.
      const pg = err as { code?: string; constraint?: string };
      if (pg.code === PG_UNIQUE_VIOLATION && pg.constraint && PHONE_UNIQUE_INDEXES.has(pg.constraint)) return 'PHONE_IN_USE';
      throw err;
    }
    if (res.rowCount !== 1) throw new Error('PHONE_VERIFICATION_NOT_WRITTEN');
    return 'ok';
  }

  async methodFor(challengeId: string): Promise<{ method: PhoneVerificationMethod; challengeId: string | null }> {
    // Plano B (Twilio Verify): o id é um `VE...` e não existe em `otp_challenges`; só ids uuid são consultados.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challengeId)) {
      return { method: 'otp_verify_whatsapp', challengeId: null };
    }
    const { rows } = await this.pool.query(`SELECT 1 FROM otp_challenges WHERE id = $1`, [challengeId]);
    return rows.length > 0
      ? { method: 'otp_whatsapp_template', challengeId }
      : { method: 'otp_verify_whatsapp', challengeId: null };
  }

  async claimChallengePhone(challengeId: string): Promise<string | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challengeId)) return null;
    const { rows } = await this.pool.query<{ phone_e164: string }>(
      `SELECT phone_e164 FROM otp_challenges WHERE id = $1 AND purpose = 'claim'`,
      [challengeId],
    );
    return rows[0]?.phone_e164 ?? null;
  }

  async linkProof(absorbedId: string): Promise<{ phoneNormalized: string; method: PhoneVerificationMethod; challengeId: string | null } | null> {
    const phone = await this.pool.query<{ phone_normalized: string | null }>(`SELECT phone_normalized FROM workers WHERE id = $1`, [absorbedId]);
    const phoneNormalized = phone.rows[0]?.phone_normalized;
    if (!phoneNormalized) return null;
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM otp_challenges
        WHERE worker_id = $1 AND purpose = 'link' AND status = 'consumed' AND created_at > NOW() - INTERVAL '1 hour'
        ORDER BY created_at DESC LIMIT 1`,
      [absorbedId],
    );
    return rows[0]
      ? { phoneNormalized, method: 'otp_whatsapp_template', challengeId: rows[0].id }
      : { phoneNormalized, method: 'otp_verify_whatsapp', challengeId: null };
  }
}
