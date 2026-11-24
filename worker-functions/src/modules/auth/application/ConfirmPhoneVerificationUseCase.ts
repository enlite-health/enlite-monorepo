import { IWorkerRepository } from '@modules/worker/ports/IWorkerRepository';
import { logger, safeErrorFields } from '@shared/logging';
import { resourceIdHash } from '@shared/audit/resourceAccessLog';
import { generatePhoneCandidates, normalizePhoneAR } from '@shared/utils/phoneNormalization';
import { maskPhone } from '@shared/utils/phoneMask';
import { isClaimableWorker } from '@modules/worker/application/isClaimableWorker';
import type { OtpChallengePort } from '../ports/OtpChallengePort';
import type { IPhoneVerificationRepository, SqlRunner } from '../ports/IPhoneVerificationRepository';
import type { ConfirmClaimUseCase } from './ConfirmClaimUseCase';
import { CLAIM_CONFLICT } from './ClaimShellAbsorber';
import { buildHandoffUrl, newConflictRef } from './phoneVerificationHandoff';

export interface ConfirmPhoneVerificationInput {
  authUid: string;
  email: string;
  phone: string;
  challengeId: string;
  code: string;
}

export type ConfirmPhoneVerificationOutcome =
  | { ok: true; status: 'VERIFIED'; phoneMasked: string; verifiedAt: Date }
  | { ok: false; code: string; handoffUrl?: string };

type Log = Pick<ReturnType<typeof logger.child>, 'info' | 'warn' | 'error'>;

const PG_UNIQUE_VIOLATION = '23505';
const PHONE_UNIQUE_INDEXES = new Set(['idx_workers_phone_unique', 'uq_workers_phone_verified_now', 'uq_workers_phone_verified_otp_challenge']);

/**
 * `POST /api/workers/me/phone-verification/confirm` (emenda 077 §2.4, D777 item 2). Identidade SÓ do token. A finalidade vem do
 * estado do número, de novo (nunca do cliente):
 *   ninguém tem o número → `phone_verify`: confere o desafio e grava o telefone E as 4 colunas `phone_verified_*` num UPDATE só.
 *                          É a ÚNICA rota que troca um telefone já gravado: a posse do NOVO foi provada (o `init` segue PHONE_LOCKED).
 *   ficha importada tem  → `claim`: o `ConfirmClaimUseCase` une (casca absorve a importada) e a prova entra NA MESMA transação.
 *   conta real tem       → PHONE_IN_USE (nada gravado, desafio não é consumido).
 * A verificação ANTIGA morre sozinha (é derivada): a troca não limpa as colunas.
 */
export class ConfirmPhoneVerificationUseCase {
  constructor(
    private readonly workers: IWorkerRepository,
    private readonly verification: IPhoneVerificationRepository,
    private readonly challenges: OtpChallengePort,
    private readonly claim: ConfirmClaimUseCase,
    /** Pool: o UPDATE do `phone_verify` é uma instrução só (atômica por si). */
    private readonly db: SqlRunner,
  ) {}

  async execute(input: ConfirmPhoneVerificationInput): Promise<ConfirmPhoneVerificationOutcome> {
    const normalized = normalizePhoneAR(input.phone);
    if (normalized.length < 10 || normalized.length > 15) return { ok: false, code: 'INVALID_PHONE' };

    const ownResult = await this.workers.findByAuthUid(input.authUid);
    if (ownResult.isFailure) return { ok: false, code: 'INTERNAL' };
    const own = ownResult.getValue();
    if (!own) return { ok: false, code: 'WORKER_NOT_FOUND' };
    const log = logger.child({ source: 'ConfirmPhoneVerificationUseCase:execute', workerIdHash: resourceIdHash(own.id) });

    const holderResult = await this.workers.findByPhoneCandidates(generatePhoneCandidates(input.phone));
    if (holderResult.isFailure) return { ok: false, code: 'INTERNAL' };
    const holder = holderResult.getValue();
    const other = holder !== null && holder.id !== own.id ? holder : null;

    if (other) {
      const claimable = await isClaimableWorker(this.workers, other);
      if (claimable.isFailure) return { ok: false, code: 'INTERNAL' };
      if (!claimable.getValue()) {
        log.info({ msg: 'phone_verification_confirm', code: 'PHONE_IN_USE' });
        return { ok: false, code: 'PHONE_IN_USE' };
      }
      return this.confirmClaim(input, own.id, other.id, log);
    }

    let checked: Awaited<ReturnType<OtpChallengePort['check']>>;
    try {
      checked = await this.challenges.check({
        challengeId: input.challengeId,
        workerId: own.id,
        phoneOnRecord: `+${normalized}`,
        code: input.code,
        ctx: { workerId: own.id, tokenEmail: input.email, fichaIsTest: async () => own.isTest === true },
      });
    } catch (err: unknown) {
      log.error({ ...safeErrorFields(err), msg: 'phone_verification_confirm_failed', code: 'OTP_CHECK_FAILED' });
      return { ok: false, code: 'OTP_CHECK_FAILED' };
    }
    if (!checked.ok) {
      log.warn({ msg: 'phone_verification_confirm', code: checked.code });
      return { ok: false, code: checked.code };
    }

    try {
      const proof = await this.verification.methodFor(input.challengeId);
      await this.verification.markPhoneVerified(this.db, { workerId: own.id, phoneNormalized: normalized, ...proof });
    } catch (err: unknown) {
      // DT-51: a mensagem do Postgres ecoa a linha (PII): só o código e o nome do índice; nada disso vai à resposta.
      const pg = err as { code?: string; constraint?: string };
      if (pg.code === PG_UNIQUE_VIOLATION && pg.constraint && PHONE_UNIQUE_INDEXES.has(pg.constraint)) {
        log.warn({ msg: 'phone_verification_confirm', code: 'PHONE_IN_USE' });
        return { ok: false, code: 'PHONE_IN_USE' };
      }
      log.error({ ...safeErrorFields(err), msg: 'phone_verification_confirm_failed', code: 'PHONE_VERIFICATION_NOT_WRITTEN' });
      return { ok: false, code: 'PHONE_VERIFICATION_NOT_WRITTEN' };
    }
    return this.verified(own.id, 'VERIFIED', log);
  }

  private async confirmClaim(
    input: ConfirmPhoneVerificationInput,
    ownId: string,
    candidateId: string,
    log: Log,
  ): Promise<ConfirmPhoneVerificationOutcome> {
    const proof = await this.verification.methodFor(input.challengeId);
    const result = await this.claim.execute(
      { verificationSid: input.challengeId, otp: input.code, authUid: input.authUid, email: input.email, candidateWorkerId: candidateId },
      // A prova entra na sobrevivente (a conta do token) DENTRO da transação da união: falhou aqui, a união inteira desfaz.
      { afterAbsorb: (tx) => this.verification.markPhoneVerified(tx, { workerId: ownId, ...proof }) },
    );
    if (result.isFailure) {
      const code = result.error!;
      if (code === CLAIM_CONFLICT) {
        const ref = newConflictRef();
        log.warn({ msg: 'claim_conflict', code: CLAIM_CONFLICT, ref });
        return { ok: false, code, handoffUrl: buildHandoffUrl(ref) };
      }
      log.warn({ msg: 'phone_verification_confirm', code: code.startsWith('TWILIO_ERROR') ? 'OTP_CHECK_FAILED' : code });
      return { ok: false, code: code.startsWith('TWILIO_ERROR') ? 'OTP_CHECK_FAILED' : code };
    }
    return this.verified(ownId, 'VERIFIED', log);
  }

  private async verified(workerId: string, status: 'VERIFIED', log: Log): Promise<ConfirmPhoneVerificationOutcome> {
    const state = await this.verification.readState(workerId);
    if (!state || state.state !== 'verified' || !state.phone || !state.verifiedAt) {
      log.error({ msg: 'phone_verification_confirm_failed', code: 'NOT_VERIFIED_AFTER_WRITE' });
      return { ok: false, code: 'NOT_VERIFIED_AFTER_WRITE' };
    }
    log.info({ msg: 'phone_verification_confirm', code: status });
    return { ok: true, status, phoneMasked: maskPhone(state.phone), verifiedAt: state.verifiedAt };
  }
}
