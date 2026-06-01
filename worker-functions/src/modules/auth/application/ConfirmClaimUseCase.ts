import { IWorkerRepository } from '@modules/worker/ports/IWorkerRepository';
import { Worker } from '@modules/worker/domain/Worker';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';
import { ITwilioVerifyService } from '../infrastructure/TwilioVerifyService';

const IMPORT_PREFIXES = [
  'anacareimport_',
  'candidatoimport_',
  'pretalnimport_',
  'base1import_',
  'clickup_encuadre_',
] as const;

function isImportedWorker(authUid: string | null | undefined): boolean {
  if (!authUid) return false;
  return IMPORT_PREFIXES.some(prefix => authUid.startsWith(prefix));
}

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
  | 'NOT_IMPORTABLE';

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
 */
export class ConfirmClaimUseCase {
  constructor(
    private readonly workerRepository: IWorkerRepository,
    private readonly twilioVerify: ITwilioVerifyService,
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

    // 3. Verifica que a ficha ainda é importable (não foi reclamada em paralelo)
    if (!isImportedWorker(candidate.authUid)) {
      log.warn({
        msg: 'claim_confirm_candidate_not_importable_anymore',
        currentAuthUid: candidate.authUid,
      });
      return Result.fail<Worker>('NOT_IMPORTABLE');
    }

    // 4. Transferência transacional
    const consentAt = new Date();
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
