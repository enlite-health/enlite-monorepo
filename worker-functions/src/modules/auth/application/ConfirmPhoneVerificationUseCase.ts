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
import { resolveConsentAcceptedAt } from './consentAcceptedAt';

export interface ConfirmPhoneVerificationInput {
  authUid: string;
  email: string;
  /**
   * Ausente só vale quando o desafio é de claim (D797, caso T-13: o app só conhece o celular MASCARADO). O servidor lê o número do
   * próprio desafio (`otp_challenges.phone_e164`) ou, no plano B (sem linha), do telefone gravado na ficha do e-mail do token; a
   * amarra DP-21 segue conferindo contra o número GRAVADO na ficha. Para `phone_verify` o número do cliente continua obrigatório.
   */
  phone?: string;
  challengeId: string;
  code: string;
  /** Hora ISO em que a caixa do aceite foi marcada no app. Ausente = sem aceite explícito: nada de consentimento é gravado. */
  consentAcceptedAt?: string;
}

export type ConfirmPhoneVerificationOutcome =
  | { ok: true; status: 'VERIFIED'; phoneMasked: string; verifiedAt: Date }
  | { ok: false; code: string; handoffUrl?: string };

type Log = Pick<ReturnType<typeof logger.child>, 'info' | 'warn' | 'error'>;

const validPhone = (phone: string): boolean => {
  const n = normalizePhoneAR(phone);
  return n.length >= 10 && n.length <= 15;
};

const PG_UNIQUE_VIOLATION = '23505';
const PHONE_UNIQUE_INDEXES = new Set(['idx_workers_phone_unique', 'uq_workers_phone_verified_now', 'uq_workers_phone_verified_otp_challenge']);

/**
 * `POST /api/workers/me/phone-verification/confirm` (emenda 077 §2.4, D777 item 2). Identidade SÓ do token. A finalidade vem do
 * estado do número, de novo (nunca do cliente):
 *   ninguém tem o número → `phone_verify`: confere o desafio e grava o telefone E as 4 colunas `phone_verified_*` num UPDATE só.
 *                          É a ÚNICA rota que troca um telefone já gravado: a posse do NOVO foi provada (o `init` segue PHONE_LOCKED).
 *   ficha importada tem  → `claim`: o `ConfirmClaimUseCase` une (casca absorve a importada) e a prova entra NA MESMA transação.
 *   conta real tem       → PHONE_IN_USE (nada gravado, desafio não é consumido).
 * Conta SEM ficha própria (D797/T-13: o app não cria ficha): só o ramo `claim` vale. O claim LIGA a conta à ficha importada (grava o
 * `auth_uid` do token nela, com as guardas de sempre) e a prova do celular e o aceite entram NA FICHA RECLAMADA. Sem ficha e sem
 * ficha para reclamar → WORKER_NOT_FOUND; ficha que já tem login → NOT_IMPORTABLE.
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
    if (input.phone !== undefined && !validPhone(input.phone)) return { ok: false, code: 'INVALID_PHONE' };
    // Antes de qualquer efeito (OTP consumido, telefone gravado): hora de aceite fora da janela recusa o pedido inteiro.
    const consentAt = input.consentAcceptedAt === undefined ? undefined : resolveConsentAcceptedAt(input.consentAcceptedAt);
    if (consentAt === null) return { ok: false, code: 'INVALID_CONSENT_AT' };

    const ownResult = await this.workers.findByAuthUid(input.authUid);
    if (ownResult.isFailure) return { ok: false, code: 'INTERNAL' };
    const own = ownResult.getValue();
    const log = logger.child({ source: 'ConfirmPhoneVerificationUseCase:execute', workerIdHash: own ? resourceIdHash(own.id) : 'sem_ficha' });

    let phone = input.phone;
    if (phone === undefined) {
      const resolved = await this.resolveClaimPhone(input, own?.id ?? null);
      if (!resolved.ok) return resolved;
      phone = resolved.phone;
      if (!validPhone(phone)) return { ok: false, code: 'INVALID_PHONE' };
    }
    const normalized = normalizePhoneAR(phone);

    const holderResult = await this.workers.findByPhoneCandidates(generatePhoneCandidates(phone));
    if (holderResult.isFailure) return { ok: false, code: 'INTERNAL' };
    const holder = holderResult.getValue();
    const other = holder !== null && holder.id !== own?.id ? holder : null;

    if (!own) {
      // Sem ficha própria só o claim existe: precisa de uma ficha importada reclamável com este número.
      if (!other) return { ok: false, code: 'WORKER_NOT_FOUND' };
      const claimable = await isClaimableWorker(this.workers, other);
      if (claimable.isFailure) return { ok: false, code: 'INTERNAL' };
      // Mesmo código do claim (ConfirmClaimUseCase) para ficha que já tem login: recusa ANTES do OTP, o desafio não é consumido.
      if (!claimable.getValue()) return { ok: false, code: 'NOT_IMPORTABLE' };
      return this.confirmClaim(input, null, other.id, consentAt, log);
    }

    if (other) {
      const claimable = await isClaimableWorker(this.workers, other);
      if (claimable.isFailure) return { ok: false, code: 'INTERNAL' };
      if (!claimable.getValue()) {
        log.info({ msg: 'phone_verification_confirm', code: 'PHONE_IN_USE' });
        return { ok: false, code: 'PHONE_IN_USE' };
      }
      return this.confirmClaim(input, own.id, other.id, consentAt, log);
    }

    // Aceite explícito entra ANTES do OTP: falha alta sem consumir o desafio, e é idempotente (COALESCE: o 1º aceite vale).
    if (consentAt) {
      let saved = false;
      try {
        saved = await this.workers.recordConsentIfMissing(own.id, consentAt);
      } catch (err: unknown) {
        log.error({ ...safeErrorFields(err), msg: 'phone_verification_confirm_failed', code: 'CONSENT_NOT_RECORDED' });
      }
      if (!saved) return { ok: false, code: 'CONSENT_NOT_RECORDED' };
    }

    let checked: Awaited<ReturnType<OtpChallengePort['check']>>;
    try {
      checked = await this.challenges.check({
        challengeId: input.challengeId,
        workerId: own.id,
        purpose: 'phone_verify',
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

  /** Sem `phone` do cliente (D797): número do desafio de claim; plano B, o telefone gravado na ficha do e-mail do token (outra que a do token). */
  private async resolveClaimPhone(input: ConfirmPhoneVerificationInput, ownId: string | null): Promise<{ ok: true; phone: string } | { ok: false; code: string }> {
    const fromChallenge = await this.verification.claimChallengePhone(input.challengeId);
    if (fromChallenge) return { ok: true, phone: fromChallenge };
    // Desafio próprio que não é de claim (ex.: phone_verify): o número tem de vir do cliente.
    if (await this.verification.methodFor(input.challengeId).then((m) => m.challengeId !== null)) return { ok: false, code: 'INVALID_PHONE' };
    const ficha = await this.workers.findByEmail(input.email);
    if (ficha.isFailure) return { ok: false, code: 'INTERNAL' };
    const candidate = ficha.getValue();
    if (!candidate || candidate.id === ownId || !candidate.phone) return { ok: false, code: 'CANDIDATE_NOT_FOUND' };
    return { ok: true, phone: candidate.phone };
  }

  private async confirmClaim(
    input: ConfirmPhoneVerificationInput,
    ownId: string | null,
    candidateId: string,
    consentAt: Date | undefined,
    log: Log,
  ): Promise<ConfirmPhoneVerificationOutcome> {
    const proof = await this.verification.methodFor(input.challengeId);
    const result = await this.claim.execute(
      { verificationSid: input.challengeId, otp: input.code, authUid: input.authUid, email: input.email, candidateWorkerId: candidateId, consentAt },
      {
        // A prova entra na sobrevivente (a conta do token) DENTRO da transação da união: falhou aqui, a união inteira desfaz.
        afterAbsorb: (tx) => this.verification.markPhoneVerified(tx, { workerId: ownId ?? candidateId, ...proof }),
        // Sem ficha própria (D797): a ficha reclamada É a conta; a prova entra nela na transação do `auth_uid`.
        afterAdopt: (tx) => this.verification.markPhoneVerified(tx, { workerId: candidateId, ...proof }),
      },
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
    return this.verified(ownId ?? candidateId, 'VERIFIED', log);
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
