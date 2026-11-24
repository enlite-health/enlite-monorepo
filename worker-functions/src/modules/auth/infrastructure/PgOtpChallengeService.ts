import crypto from 'crypto';
import type { Pool } from 'pg';
import { logger, safeErrorFields } from '@shared/logging';
import {
  OtpChallengePort,
  OtpCheckInput,
  OtpCheckOutcome,
  OtpPurpose,
  OtpStartInput,
} from '../ports/OtpChallengePort';
import { shouldSuppressOtp } from '../application/IsTestOtpGuard';
import type { TwilioAuthTemplateSender } from './TwilioAuthTemplateSender';

/** Validade do código (a mesma do Verify). */
const OTP_TTL_MINUTES = 10;
/** Tentativas erradas por desafio; a N-ésima cancela. O quadro completo de limites é do cartão de limites (T-F3c-111). */
const MAX_ATTEMPTS = 5;
const MIN_PEPPER_LENGTH = 32;

/**
 * OTP próprio (D758): gera o código de 6 dígitos, grava SÓ o HMAC em `otp_challenges` e delega o envio ao
 * `TwilioAuthTemplateSender`. O pepper vem de secret (`OTP_HMAC_PEPPER`); sem ele (ou curto demais) NADA é emitido nem
 * aceito — falha fechada. Código e telefone nunca vão para log.
 */
export class PgOtpChallengeService implements OtpChallengePort {
  constructor(
    private readonly pool: Pick<Pool, 'connect' | 'query'>,
    private readonly sender: Pick<TwilioAuthTemplateSender, 'send'>,
    private readonly pepper: () => string | undefined = () => process.env.OTP_HMAC_PEPPER,
    /** Código fixo para ficha de teste suprimida (E2E_OTP_CODE): sem ele, nenhum código vale (falha fechada). */
    private readonly suppressedCode: () => string | undefined = () => process.env.E2E_OTP_CODE,
  ) {}

  /** Falha FECHADA: sem pepper (ou curto demais) nada é emitido nem conferido, e nenhuma linha é tocada. */
  private assertPepper(): string {
    const pepper = this.pepper();
    if (!pepper || pepper.length < MIN_PEPPER_LENGTH) throw new Error('OTP_HMAC_PEPPER not configured');
    return pepper;
  }

  private hmac(challengeId: string, purpose: string, code: string): string {
    return crypto.createHmac('sha256', this.assertPepper()).update(`${challengeId}|${purpose}|${code}`).digest('hex');
  }

  async start(input: OtpStartInput): Promise<{ challengeId: string }> {
    const challengeId = crypto.randomUUID();
    const suppressed = shouldSuppressOtp(input.ctx);
    const code = (suppressed && this.suppressedCode()) || crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHmac = this.hmac(challengeId, input.purpose, code);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE otp_challenges SET status = 'canceled'
          WHERE worker_id = $1 AND purpose = $2 AND status = 'pending'`,
        [input.workerId, input.purpose],
      );
      await client.query(
        `INSERT INTO otp_challenges (id, worker_id, purpose, phone_e164, code_hmac, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(mins => $6))`,
        [challengeId, input.workerId, input.purpose, input.phoneE164, codeHmac, OTP_TTL_MINUTES],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    let sent: Awaited<ReturnType<typeof this.sender.send>>;
    try {
      sent = await this.sender.send({ toE164: input.phoneE164, code, ctx: input.ctx });
    } catch (err) {
      // Canal indisponível: o desafio não pode ficar pendente (ninguém recebeu o código).
      await this.pool.query(
        `UPDATE otp_challenges SET status = 'canceled', send_status = 'failed' WHERE id = $1`,
        [challengeId],
      );
      throw err;
    }

    // O código JÁ foi entregue: se só o registro do sid falhar, o desafio vale. Cancelá-lo deixaria a cuidadora com um
    // código na mão que o sistema recusa. Registra o erro (sem PII) e segue.
    try {
      await this.pool.query(`UPDATE otp_challenges SET twilio_sid = $2, send_status = $3 WHERE id = $1`, [
        challengeId,
        sent.twilioSid ?? null,
        sent.suppressed ? 'suppressed' : 'sent',
      ]);
    } catch (err) {
      logger.child({ source: 'PgOtpChallengeService:start' }).warn({ msg: 'otp_send_record_failed', challengeId, ...safeErrorFields(err) });
    }

    logger.child({ source: 'PgOtpChallengeService:start' }).info({ msg: 'otp_challenge_started', challengeId, purpose: input.purpose });
    return { challengeId };
  }

  async check(input: OtpCheckInput): Promise<OtpCheckOutcome> {
    this.assertPepper();

    // 1. A tentativa é CONTADA ANTES de comparar, num único UPDATE atômico com o teto na própria condição: N conferências
    //    paralelas não passam de MAX_ATTEMPTS (compare-depois-incrementa deixaria todas passarem). O telefone da ficha (DP-21)
    //    entra aqui: código emitido para outro telefone não chega à comparação.
    const counted = await this.pool.query<{ code_hmac: string; purpose: OtpPurpose; attempts: number }>(
      `UPDATE otp_challenges SET attempts = attempts + 1
        WHERE id = $1 AND worker_id = $2
          AND status = 'pending' AND expires_at > NOW() AND attempts < $4
          AND phone_e164 = $3
        RETURNING code_hmac, purpose, attempts`,
      [input.challengeId, input.workerId, input.phoneOnRecord, MAX_ATTEMPTS],
    );

    if (counted.rowCount === 1) {
      const { code_hmac: stored, purpose, attempts } = counted.rows[0];
      const given = Buffer.from(this.hmac(input.challengeId, purpose, input.code), 'hex');
      const expected = Buffer.from(stored, 'hex');
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
        // 2. Consumo único: só uma conferência simultânea do mesmo código devolve linha.
        const consumed = await this.pool.query(
          `UPDATE otp_challenges SET status = 'consumed' WHERE id = $1 AND status = 'pending' AND expires_at > NOW() RETURNING id`,
          [input.challengeId],
        );
        if (consumed.rowCount === 1) return { ok: true };
        return this.diagnose(input);
      }
      if (attempts >= MAX_ATTEMPTS) {
        await this.pool.query(`UPDATE otp_challenges SET status = 'canceled' WHERE id = $1 AND status = 'pending'`, [input.challengeId]);
      }
      return { ok: false, code: 'INVALID_OTP' };
    }

    return this.diagnose(input);
  }

  /** Não houve tentativa contada: diz POR QUE o desafio não vale. */
  private async diagnose(input: OtpCheckInput): Promise<OtpCheckOutcome> {
    const state = await this.pool.query<{ status: string; expired: boolean; attempts: number }>(
      `SELECT status, (expires_at <= NOW()) AS expired, attempts FROM otp_challenges WHERE id = $1 AND worker_id = $2`,
      [input.challengeId, input.workerId],
    );
    const row = state.rows[0];
    if (!row) return { ok: false, code: 'INVALID_OTP' };
    if (row.status === 'consumed') return { ok: false, code: 'OTP_ALREADY_USED' };
    if (row.status === 'canceled' || row.expired || row.attempts >= MAX_ATTEMPTS) return { ok: false, code: 'EXPIRED_OTP' };
    // Vivo, mas o telefone da ficha não é o do desafio (DP-21): recusa sem contar (o telefone vem do banco, não do cliente).
    return { ok: false, code: 'INVALID_OTP' };
  }

  async cancel(input: { workerId: string; purpose: OtpPurpose }): Promise<void> {
    await this.pool.query(
      `UPDATE otp_challenges SET status = 'canceled' WHERE worker_id = $1 AND purpose = $2 AND status = 'pending'`,
      [input.workerId, input.purpose],
    );
  }
}
