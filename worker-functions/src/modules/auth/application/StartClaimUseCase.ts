import { IWorkerRepository } from '@modules/worker/ports/IWorkerRepository';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';
import { generatePhoneCandidates, normalizePhoneAR } from '@shared/utils/phoneNormalization';
import { maskPhone, maskPhoneForLog } from '@shared/utils/phoneMask';
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

export interface StartClaimInput {
  authUid: string;
  email: string;
  phone: string;
}

export type StartClaimOutput =
  | { noCandidate: true }
  | { candidateWorkerId: string; phoneMasked: string; verificationSid: string };

/**
 * Inicia um claim de ficha importada via OTP SMS.
 *
 * Fluxo:
 *   1. Valida se o phone tem comprimento razoável (≥10 dígitos após normalização).
 *   2. Busca candidatos no banco (variantes do número).
 *   3. Se encontrou ficha importada (fake authUid), dispara Twilio Verify
 *      para o phone DA FICHA (não o do payload — proteção anti-hijack).
 *   4. Retorna verificationSid + phoneMasked para o frontend exibir.
 *   5. Se nenhum candidato encontrado, retorna { noCandidate: true }.
 *
 * Rate limit: delegado ao controller (express-rate-limit por IP).
 */
export class StartClaimUseCase {
  constructor(
    private readonly workerRepository: IWorkerRepository,
    private readonly twilioVerify: ITwilioVerifyService,
  ) {}

  async execute(input: StartClaimInput): Promise<Result<StartClaimOutput>> {
    const startedAt = Date.now();

    const log = logger.child({
      source: 'StartClaimUseCase:execute',
      authUid: input.authUid,
      phoneMasked: maskPhoneForLog(input.phone),
    });

    log.info({ msg: 'claim_start_requested' });

    const normalized = normalizePhoneAR(input.phone);
    if (normalized.length < 10) {
      return Result.fail<StartClaimOutput>('INVALID_PHONE');
    }

    const candidates = generatePhoneCandidates(input.phone);
    const phoneCheckResult = await this.workerRepository.findByPhoneCandidates(candidates);

    if (phoneCheckResult.isFailure) {
      return Result.fail<StartClaimOutput>(phoneCheckResult.error!);
    }

    const candidate = phoneCheckResult.getValue();

    if (!candidate || !isImportedWorker(candidate.authUid)) {
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
      const { verificationSid } = await this.twilioVerify.startVerification(phoneE164);

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
      const twilioCode = (err as { code?: number | string }).code ?? null;
      const errorMessage = err instanceof Error ? err.message : String(err);

      log.error({
        msg: 'claim_start_twilio_failed',
        candidateWorkerId,
        twilioCode,
        errorMessage,
        durationMs: Date.now() - startedAt,
      });

      return Result.fail<StartClaimOutput>(`TWILIO_ERROR:${errorMessage}`);
    }
  }
}
