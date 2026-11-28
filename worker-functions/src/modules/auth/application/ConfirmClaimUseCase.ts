import { IWorkerRepository } from '@modules/worker/ports/IWorkerRepository';
import { Worker } from '@modules/worker/domain/Worker';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';
import { isClaimableWorker } from '@modules/worker/application/isClaimableWorker';
import { normalizePhoneAR } from '@shared/utils/phoneNormalization';
import type { OtpChallengePort } from '../ports/OtpChallengePort';
import type { SqlRunner } from '../ports/IPhoneVerificationRepository';
import { CLAIM_CONFLICT, type IClaimShellAbsorber } from './ClaimShellAbsorber';

export interface ConfirmClaimInput {
  verificationSid: string;
  otp: string;
  authUid: string;
  email: string;
  candidateWorkerId: string;
  /**
   * Aceite EXPLÍCITO da política (a caixa foi marcada). Sem ele o OTP NÃO presume consentimento: o trio
   * `lgpd_consent_at`/`terms_accepted_at`/`privacy_accepted_at` fica como está (NULL continua NULL).
   */
  consentAt?: Date;
}

export type ConfirmClaimError =
  | 'INVALID_OTP'
  | 'EXPIRED_OTP'
  | 'OTP_ALREADY_USED'
  | 'CANDIDATE_NOT_FOUND'
  | 'NOT_IMPORTABLE'
  | 'CLAIM_CONFLICT';

/**
 * Confirma o OTP e executa a transferência da ficha importada para o novo authUid.
 *
 * Fluxo:
 *   1. Chama Twilio Verify para validar o código OTP.
 *   2. Re-fetcha a ficha (defensivo — proteção contra race condition).
 *   3. Verifica que a ficha ainda é importable (authUid fake).
 *   4. Executa updateImportedWorkerData (transacional no repositório).
 *   5. Retorna o worker atualizado.
 *
 * Erros estruturados (retornam Result.fail):
 *   INVALID_OTP        — código errado
 *   EXPIRED_OTP        — verificação expirada ou cancelada
 *   CANDIDATE_NOT_FOUND — workerId não encontrado no banco
 *   NOT_IMPORTABLE      — ficha já tem authUid real (race condition ou fraude)
 *   CLAIM_CONFLICT      — o authUid já tem OUTRA ficha e ela não é casca (D764): nada gravado
 *
 * Conta que já tem ficha (X ≠ candidata): o `SET auth_uid` estouraria `workers_auth_uid_key` (500, M-7). Se X é
 * casca, a importada é absorvida em X (X segura o uid; ver ClaimShellAbsorber); senão CLAIM_CONFLICT.
 */
export class ConfirmClaimUseCase {
  constructor(
    private readonly workerRepository: IWorkerRepository,
    private readonly otp: OtpChallengePort,
    private readonly shellAbsorber?: IClaimShellAbsorber,
  ) {}

  /**
   * `afterAbsorb` (só no ramo da casca): roda na transação da absorção, depois do consentimento. É por onde o
   * `confirm` do celular verificado grava a prova na ficha sobrevivente, na MESMA transação da união.
   */
  /**
   * `afterAdopt` (só no ramo SEM ficha própria, D797/T-13): a conta do token passa a ser a ficha importada (`auth_uid` gravado nela);
   * o gancho roda na transação desse UPDATE, para a prova do celular entrar NA FICHA RECLAMADA junto da ligação.
   */
  async execute(
    input: ConfirmClaimInput,
    hooks: { afterAbsorb?: (tx: SqlRunner) => Promise<void>; afterAdopt?: (tx: SqlRunner) => Promise<void> } = {},
  ): Promise<Result<Worker>> {
    const startedAt = Date.now();

    const log = logger.child({
      source: 'ConfirmClaimUseCase:execute',
      authUid: input.authUid,
      candidateWorkerId: input.candidateWorkerId,
      verificationSid: input.verificationSid,
      codeLength: input.otp.length,
    });

    log.info({ msg: 'claim_confirm_requested' });

    // 1. Re-fetch defensivo (proteção contra race condition) — também dá o telefone GRAVADO, que o OTP confere (DP-21)
    const candidateResult = await this.workerRepository.findById(input.candidateWorkerId);
    if (candidateResult.isFailure) {
      return Result.fail<Worker>(candidateResult.error!);
    }

    const candidate = candidateResult.getValue();
    if (!candidate) {
      log.warn({ msg: 'claim_confirm_candidate_not_found' });
      return Result.fail<Worker>('CANDIDATE_NOT_FOUND');
    }

    // 2. Validar o OTP pelo port. DP-21: o desafio só vale se foi emitido para o telefone DESTA ficha (lido do banco aqui,
    //    nunca o do cliente): código aprovado para o telefone A (do atacante) não reivindica a ficha B.
    const phoneOnRecord = candidate.phone
      ? candidate.phone.startsWith('+') ? candidate.phone : `+${normalizePhoneAR(candidate.phone)}`
      : '';
    let outcome: Awaited<ReturnType<OtpChallengePort['check']>>;
    try {
      outcome = await this.otp.check({
        challengeId: input.verificationSid,
        workerId: input.candidateWorkerId,
        purpose: 'claim',
        phoneOnRecord,
        code: input.otp,
        // `candidateWorkerId` vem do corpo: a guarda de OTP de teste (plano B) só aceita se for a ficha do envio,
        // lida do banco agora, E de teste.
        ctx: { workerId: input.candidateWorkerId, tokenEmail: input.email, fichaIsTest: async () => candidate.isTest === true },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Result.fail<Worker>(`TWILIO_ERROR:${msg}`);
    }

    if (!outcome.ok) {
      log.warn({ msg: outcome.code === 'EXPIRED_OTP' ? 'claim_confirm_otp_expired' : 'claim_confirm_otp_invalid', code: outcome.code });
      return Result.fail<Worker>(outcome.code);
    }

    // 3. Verifica que a ficha ainda é importable (não foi reclamada em paralelo)
    const claimable = await isClaimableWorker(this.workerRepository, candidate);
    if (claimable.isFailure) {
      return Result.fail<Worker>(claimable.error!);
    }
    if (!claimable.getValue()) {
      log.warn({
        msg: 'claim_confirm_candidate_not_importable_anymore',
        currentAuthUid: candidate.authUid,
      });
      return Result.fail<Worker>('NOT_IMPORTABLE');
    }

    // 3b. D764: o authUid do token já tem OUTRA ficha? (findByAuthUid segue a corrente de merges.)
    const consentAt = input.consentAt;
    const ownResult = await this.workerRepository.findByAuthUid(input.authUid);
    if (ownResult.isFailure) {
      return Result.fail<Worker>(ownResult.error!);
    }
    const own = ownResult.getValue();
    if (own !== null && own.id !== candidate.id) {
      if (!this.shellAbsorber) {
        log.warn({ msg: 'claim_conflict_no_absorber' });
        return Result.fail<Worker>(CLAIM_CONFLICT);
      }
      const absorbed = await this.shellAbsorber.absorbImportedIntoExisting({
        existingId: own.id,
        importedId: candidate.id,
        authUid: input.authUid,
        consentAt,
        afterAbsorb: hooks.afterAbsorb,
      });
      if (absorbed.isFailure) {
        log.warn({ msg: 'claim_absorb_refused', error: absorbed.error });
        return Result.fail<Worker>(absorbed.error!);
      }
      // Com aceite explícito, ele já foi gravado em X dentro da transação da absorção; aqui só relê o resultado.
      const reread = await this.workerRepository.findByAuthUid(input.authUid);
      if (reread.isFailure || reread.getValue() === null) {
        log.error({ msg: 'claim_absorbed_reread_failed' });
        return Result.fail<Worker>('CLAIM_ABSORB_FAILED');
      }
      log.info({ msg: 'claim_confirm_success', durationMs: Date.now() - startedAt, absorbedShell: true });
      return Result.ok<Worker>(reread.getValue()!);
    }

    // 4. Transferência transacional
    const adoptArgs = [input.candidateWorkerId, { authUid: input.authUid, email: input.email, consentAt }] as const;
    const updateResult = hooks.afterAdopt
      ? await this.workerRepository.updateImportedWorkerData(...adoptArgs, hooks.afterAdopt)
      : await this.workerRepository.updateImportedWorkerData(...adoptArgs);

    if (updateResult.isFailure) {
      log.error({
        msg: 'claim_confirm_update_failed',
        errorMessage: updateResult.error,
      });
      return Result.fail<Worker>(updateResult.error!);
    }

    log.info({
      msg: 'claim_confirm_success',
      durationMs: Date.now() - startedAt,
    });

    return Result.ok<Worker>(updateResult.getValue());
  }
}
