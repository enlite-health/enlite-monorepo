import { IWorkerRepository } from '@modules/worker/ports/IWorkerRepository';
import { Worker } from '@modules/worker/domain/Worker';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';
import { isClaimableWorker } from '@modules/worker/application/isClaimableWorker';
import { ITwilioVerifyService, otpCheckIsForPhone } from '../infrastructure/TwilioVerifyService';
import { CLAIM_CONFLICT, type IClaimShellAbsorber } from './ClaimShellAbsorber';

export interface ConfirmClaimInput {
  verificationSid: string;
  otp: string;
  authUid: string;
  email: string;
  candidateWorkerId: string;
}

export type ConfirmClaimError =
  | 'INVALID_OTP'
  | 'EXPIRED_OTP'
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
    private readonly twilioVerify: ITwilioVerifyService,
    private readonly shellAbsorber?: IClaimShellAbsorber,
  ) {}

  async execute(input: ConfirmClaimInput): Promise<Result<Worker>> {
    const startedAt = Date.now();

    const log = logger.child({
      source: 'ConfirmClaimUseCase:execute',
      authUid: input.authUid,
      candidateWorkerId: input.candidateWorkerId,
      verificationSid: input.verificationSid,
      codeLength: input.otp.length,
    });

    log.info({ msg: 'claim_confirm_requested' });

    // 1. Validar OTP via Twilio Verify
    let checkResult: Awaited<ReturnType<ITwilioVerifyService['checkVerification']>>;

    try {
      checkResult = await this.twilioVerify.checkVerification(
        input.verificationSid,
        input.otp,
        {
          // `candidateWorkerId` vem do corpo: a guarda de OTP de teste só aceita se for a ficha do envio,
          // lida do banco agora, E de teste.
          workerId: input.candidateWorkerId,
          tokenEmail: input.email,
          fichaIsTest: async () => {
            const found = await this.workerRepository.findById(input.candidateWorkerId);
            return found.isSuccess && found.getValue()?.isTest === true;
          },
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Result.fail<Worker>(`TWILIO_ERROR:${msg}`);
    }

    if (!checkResult.valid) {
      const error: ConfirmClaimError =
        checkResult.status === 'expired' || checkResult.status === 'canceled'
          ? 'EXPIRED_OTP'
          : 'INVALID_OTP';

      if (error === 'EXPIRED_OTP') {
        log.warn({ msg: 'claim_confirm_otp_expired', twilioStatus: checkResult.status });
      } else {
        log.warn({ msg: 'claim_confirm_otp_invalid', twilioStatus: checkResult.status });
      }

      return Result.fail<Worker>(error);
    }

    // 2. Re-fetch defensivo (proteção contra race condition)
    const candidateResult = await this.workerRepository.findById(input.candidateWorkerId);
    if (candidateResult.isFailure) {
      return Result.fail<Worker>(candidateResult.error!);
    }

    const candidate = candidateResult.getValue();
    if (!candidate) {
      log.warn({ msg: 'claim_confirm_candidate_not_found' });
      return Result.fail<Worker>('CANDIDATE_NOT_FOUND');
    }

    // 2b. DP-21: o código tem de ter ido ao telefone DESTA ficha. Sem isso, um código aprovado
    //     para o telefone A (do atacante) reivindicava a ficha B. Compara com o telefone do banco.
    if (!otpCheckIsForPhone(checkResult, candidate.phone)) {
      log.warn({ msg: 'claim_confirm_otp_phone_mismatch', hasTo: Boolean(checkResult.to) });
      return Result.fail<Worker>('INVALID_OTP');
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
    const consentAt = new Date();
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
      });
      if (absorbed.isFailure) {
        log.warn({ msg: 'claim_absorb_refused', error: absorbed.error });
        return Result.fail<Worker>(absorbed.error!);
      }
      // O consentimento do OTP já foi gravado em X dentro da transação da absorção; aqui só relê o resultado.
      const reread = await this.workerRepository.findByAuthUid(input.authUid);
      if (reread.isFailure || reread.getValue() === null) {
        log.error({ msg: 'claim_absorbed_reread_failed' });
        return Result.fail<Worker>('CLAIM_ABSORB_FAILED');
      }
      log.info({ msg: 'claim_confirm_success', durationMs: Date.now() - startedAt, absorbedShell: true });
      return Result.ok<Worker>(reread.getValue()!);
    }

    // 4. Transferência transacional
    const updateResult = await this.workerRepository.updateImportedWorkerData(
      input.candidateWorkerId,
      { authUid: input.authUid, email: input.email, consentAt },
    );

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
