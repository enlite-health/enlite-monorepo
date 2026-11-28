import { IWorkerRepository } from '@modules/worker/ports/IWorkerRepository';
import { Result } from '@shared/utils/Result';
import { logger, safeErrorFields } from '@shared/logging';
import { classifyOtpPhone, generatePhoneCandidates, normalizePhoneAR } from '@shared/utils/phoneNormalization';
import { maskPhone, maskPhoneForLog } from '@shared/utils/phoneMask';
import { isClaimableWorker } from '@modules/worker/application/isClaimableWorker';
import { OtpChallengePort, isOtpStartRefusal } from '../ports/OtpChallengePort';

export interface StartClaimInput {
  authUid: string;
  email: string;
  phone: string;
}

export type StartClaimOutput =
  | { noCandidate: true }
  | { candidateWorkerId: string; phoneMasked: string; verificationSid: string };

/**
 * Inicia um claim de ficha importada: código OTP pelo `OtpChallengePort` (D758; o Twilio Verify é só o plano B de canal).
 *
 * Fluxo:
 *   1. Valida o phone digitado: só celular AR (+54) e BR (+55) — outro país → PHONE_COUNTRY_NOT_SUPPORTED, lixo → INVALID_PHONE.
 *   2. Busca candidatos no banco (variantes do número).
 *   3. Se encontrou ficha importada (fake authUid), dispara o OTP
 *      para o phone DA FICHA (não o do payload — proteção anti-hijack).
 *   4. Retorna verificationSid (= id do desafio) + phoneMasked para o frontend exibir.
 *   5. Se nenhum candidato encontrado, retorna { noCandidate: true }.
 *
 * Rate limit: delegado ao controller (express-rate-limit por IP).
 */
export class StartClaimUseCase {
  constructor(
    private readonly workerRepository: IWorkerRepository,
    private readonly otp: OtpChallengePort,
  ) {}

  async execute(input: StartClaimInput): Promise<Result<StartClaimOutput>> {
    const startedAt = Date.now();

    const log = logger.child({
      source: 'StartClaimUseCase:execute',
      authUid: input.authUid,
      phoneMasked: maskPhoneForLog(input.phone),
    });

    log.info({ msg: 'claim_start_requested' });

    const classified = classifyOtpPhone(input.phone);
    if (!classified.ok) {
      return Result.fail<StartClaimOutput>(classified.error);
    }

    const candidates = generatePhoneCandidates(input.phone);
    const phoneCheckResult = await this.workerRepository.findByPhoneCandidates(candidates);

    if (phoneCheckResult.isFailure) {
      return Result.fail<StartClaimOutput>(phoneCheckResult.error!);
    }

    const candidate = phoneCheckResult.getValue();

    const claimable = candidate ? await isClaimableWorker(this.workerRepository, candidate) : null;
    if (claimable?.isFailure) {
      return Result.fail<StartClaimOutput>(claimable.error!);
    }

    if (!candidate || !claimable?.getValue()) {
      log.info({ msg: 'claim_start_no_candidate' });
      return Result.ok<StartClaimOutput>({ noCandidate: true });
    }

    const candidateWorkerId = candidate.id;

    log.info({
      msg: 'claim_start_candidate_found',
      candidateWorkerId,
      candidatePhoneMasked: maskPhoneForLog(candidate.phone ?? ''),
    });

    // Usa o phone DA FICHA (não o do request) — proteção anti-hijack.
    // A ficha pode ter sido importada com formato ligeiramente diferente;
    // usamos o number dela pra garantir que quem recebe o OTP é o dono real.
    const phoneForOtp = candidate.phone ?? input.phone;

    // Garante formato E.164 para Twilio Verify
    const phoneE164 = phoneForOtp.startsWith('+')
      ? phoneForOtp
      : `+${normalizePhoneAR(phoneForOtp)}`;

    try {
      const { challengeId: verificationSid } = await this.otp.start({
        workerId: candidateWorkerId,
        purpose: 'claim',
        phoneE164,
        requesterUid: input.authUid,
        ctx: { workerId: candidateWorkerId, fichaIsTest: candidate.isTest === true, tokenEmail: input.email },
      });

      log.info({
        msg: 'claim_start_otp_dispatched',
        candidateWorkerId,
        verificationSid,
        durationMs: Date.now() - startedAt,
      });

      return Result.ok<StartClaimOutput>({
        candidateWorkerId,
        phoneMasked: maskPhone(phoneE164),
        verificationSid,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';

      // B8: a mensagem do Twilio carrega o telefone ("Invalid To +54…"): nem em log nem no erro devolvido.
      log.error({
        msg: 'claim_start_twilio_failed',
        candidateWorkerId,
        ...safeErrorFields(err),
        durationMs: Date.now() - startedAt,
      });

      if (isOtpStartRefusal(message)) {
        return Result.fail<StartClaimOutput>(message);
      }
      return Result.fail<StartClaimOutput>('OTP_START_FAILED');
    }
  }
}
