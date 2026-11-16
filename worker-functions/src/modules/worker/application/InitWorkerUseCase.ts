import { IWorkerRepository } from '../ports/IWorkerRepository';
import { CreateWorkerDTO, Worker } from '../domain/Worker';
import { InitWorkerOutput } from '../domain/InitWorkerOutput';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';
import { resourceIdHash } from '@shared/audit/resourceAccessLog';
import { generatePhoneCandidates, normalizePhoneAR } from '@shared/utils/phoneNormalization';
import { maskPhone, maskPhoneForLog } from '@shared/utils/phoneMask';
import { isClaimableWorker, isImportedWorker } from './isClaimableWorker';
import { ITwilioVerifyService } from '@modules/auth/infrastructure/TwilioVerifyService';

/**
 * `emailVerified` vem do token verificado (nunca do corpo): sem ele, o e-mail é só o que
 * a pessoa digitou ao criar a conta e-mail/senha — não prova que ela é dona da ficha.
 */
export interface InitWorkerInput extends CreateWorkerDTO {
  emailVerified: boolean;
}

/** Ficha com este e-mail é de outro login e o token não prova posse do e-mail (DP-20). */
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

export class InitWorkerUseCase {
  constructor(
    private workerRepository: IWorkerRepository,
    private twilioVerify?: ITwilioVerifyService,
  ) {}

  async execute(data: InitWorkerInput): Promise<Result<InitWorkerOutput>> {
    const consentAt = data.lgpdOptIn ? new Date() : undefined;

    const existingWorkerResult = await this.workerRepository.findByAuthUid(data.authUid);

    if (existingWorkerResult.isFailure) {
      return Result.fail<InitWorkerOutput>(existingWorkerResult.error!);
    }

    if (existingWorkerResult.getValue() !== null) {
      return Result.ok<InitWorkerOutput>({
        status: 'ok',
        worker: existingWorkerResult.getValue()!,
      });
    }

    const emailCheckResult = await this.workerRepository.findByEmail(data.email);

    if (emailCheckResult.isFailure) {
      return Result.fail<InitWorkerOutput>(emailCheckResult.error!);
    }

    const existingByEmail = emailCheckResult.getValue();
    if (existingByEmail !== null) {
      // Reconecta: atualiza auth_uid para worker existente com email coincidente.
      // Cobre o caso em que o usuário recriou a conta Firebase (novo authUid).
      // Também preenche phone quando o worker existente não tem mas o payload tem.
      if (!existingByEmail.authUid || existingByEmail.authUid !== data.authUid) {
        // DP-20 (tomada de ficha): conta e-mail/senha nasce com e-mail NÃO verificado, então
        // criá-la com o e-mail de uma ficha alheia não prova nada. Sem `email_verified` não
        // religa e não cria outra ficha (o e-mail já tem dona). A posse se prova pelo OTP ao
        // telefone DA FICHA (claim, amarrado ao telefone pela DP-21) quando a ficha é reclamável;
        // senão, EMAIL_NOT_VERIFIED.
        if (!data.emailVerified) {
          return this.relinkWithoutVerifiedEmail(existingByEmail);
        }
        const phoneToSet = !existingByEmail.phone && data.phone ? data.phone : undefined;
        const updateResult = await this.workerRepository.updateAuthUid(
          existingByEmail.id,
          data.authUid,
          phoneToSet,
          consentAt,
        );

        if (updateResult.isFailure) {
          return Result.fail<InitWorkerOutput>(updateResult.error!);
        }

        // Medição do efeito da DP-20 depois do deploy: só hash do id e booleanos, sem PII.
        logger.child({ source: 'InitWorkerUseCase:execute' }).info({
          msg: 'worker_relinked_by_email',
          workerIdHash: resourceIdHash(existingByEmail.id),
          emailVerified: data.emailVerified,
          fromImported: isImportedWorker(existingByEmail.authUid),
        });

        return Result.ok<InitWorkerOutput>({ status: 'ok', worker: updateResult.getValue() });
      }

      return Result.ok<InitWorkerOutput>({ status: 'ok', worker: existingByEmail });
    }

    // Verifica workers importados por telefone (ou whatsappPhone como fallback).
    // Substitui o auto-link silencioso por claim via OTP WhatsApp (anti-hijack).
    // Quem confirmar posse do número recebe a ficha.
    const phoneInput = data.phone || data.whatsappPhone;
    if (phoneInput && normalizePhoneAR(phoneInput).length >= 10) {
      const candidates = generatePhoneCandidates(phoneInput);
      const phoneCheckResult = await this.workerRepository.findByPhoneCandidates(candidates);

      if (phoneCheckResult.isSuccess && phoneCheckResult.getValue() !== null) {
        const existingByPhone = phoneCheckResult.getValue()!;

        if (isImportedWorker(existingByPhone.authUid)) {
          return this.startClaimOtp(existingByPhone, existingByPhone.phone ?? phoneInput);
        }
      }
    }

    const createResult = await this.workerRepository.create({
      authUid: data.authUid,
      email: data.email,
      phone: data.phone,
      whatsappPhone: data.whatsappPhone,
      lgpdOptIn: data.lgpdOptIn,
      country: data.country,
    });

    if (createResult.isFailure) {
      return Result.fail<InitWorkerOutput>(createResult.error!);
    }

    const worker: Worker = createResult.getValue();

    return Result.ok<InitWorkerOutput>({ status: 'ok', worker });
  }

  /**
   * Ficha achada por e-mail, de outro login, e token sem `email_verified` (DP-20). Ficha
   * reclamável COM telefone → `claim_pending` (OTP ao telefone dela; o front já abre o modal).
   * Sem telefone, ou não reclamável (login real, `talentum_`, sobrevivente que absorveu login
   * real: o confirm do claim recusaria) → EMAIL_NOT_VERIFIED. Nunca religa nem cria ficha.
   */
  private async relinkWithoutVerifiedEmail(ficha: Worker): Promise<Result<InitWorkerOutput>> {
    const log = logger.child({ source: 'InitWorkerUseCase:execute', workerIdHash: resourceIdHash(ficha.id) });
    const blocked = (): Result<InitWorkerOutput> => {
      log.warn({ msg: 'worker_relink_blocked_email_not_verified', hasPhone: Boolean(ficha.phone) });
      return Result.fail<InitWorkerOutput>(EMAIL_NOT_VERIFIED);
    };
    if (!ficha.phone) return blocked();

    const claimable = await isClaimableWorker(this.workerRepository, ficha);
    if (claimable.isFailure) return Result.fail<InitWorkerOutput>(claimable.error!);
    if (!claimable.getValue()) return blocked();

    log.info({ msg: 'worker_relink_email_not_verified_claim_otp' });
    return this.startClaimOtp(ficha, ficha.phone);
  }

  /** OTP ao telefone DA FICHA (nunca o do payload — anti-hijack) e `claim_pending`. */
  private async startClaimOtp(ficha: Worker, phoneForOtp: string): Promise<Result<InitWorkerOutput>> {
    const phoneE164 = phoneForOtp.startsWith('+') ? phoneForOtp : `+${normalizePhoneAR(phoneForOtp)}`;

    logger.child({ source: 'InitWorkerUseCase:execute', workerId: ficha.id }).info({
      msg: 'worker_claim_otp_triggered',
      candidateWorkerId: ficha.id,
      fromAuthUid: ficha.authUid,
      phoneE164: maskPhoneForLog(phoneE164),
    });

    if (!this.twilioVerify) {
      // Fallback em ambientes sem Twilio configurado (testes de integração E2E
      // que não passam twilioVerify): retorna claim_pending com sid sintético.
      return Result.ok<InitWorkerOutput>({
        status: 'claim_pending',
        candidateWorkerId: ficha.id,
        phoneMasked: maskPhone(phoneE164),
        verificationSid: 'TWILIO_NOT_CONFIGURED',
      });
    }

    try {
      const { verificationSid } = await this.twilioVerify.startVerification(phoneE164);
      return Result.ok<InitWorkerOutput>({
        status: 'claim_pending',
        candidateWorkerId: ficha.id,
        phoneMasked: maskPhone(phoneE164),
        verificationSid,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Result.fail<InitWorkerOutput>(`TWILIO_ERROR:${msg}`);
    }
  }
}
