import { IWorkerRepository } from '../ports/IWorkerRepository';
import { CreateWorkerDTO, Worker } from '../domain/Worker';
import { InitWorkerOutput } from '../domain/InitWorkerOutput';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';
import { generatePhoneCandidates, normalizePhoneAR } from '@shared/utils/phoneNormalization';
import { maskPhone } from '@shared/utils/phoneMask';
import { ITwilioVerifyService } from '@modules/auth/infrastructure/TwilioVerifyService';

/**
 * Detecta se um worker foi importado de planilha ou script (authUid fake).
 * Imported workers têm authUid com os prefixes abaixo:
 *   - anacareimport_       — Anacare import
 *   - candidatoimport_     — importação genérica de candidatos
 *   - pretalnimport_       — Pretaln import
 *   - base1import_         — Planilla Operativa importer
 *   - clickup_encuadre_    — scripts/import-encuadres-from-clickup.ts
 */
function isImportedWorker(authUid: string | null | undefined): boolean {
  if (!authUid) return false;
  const importPrefixes = [
    'anacareimport_',
    'candidatoimport_',
    'pretalnimport_',
    'base1import_',
    'clickup_encuadre_',
  ];
  return importPrefixes.some(prefix => authUid.startsWith(prefix));
}

export class InitWorkerUseCase {
  constructor(
    private workerRepository: IWorkerRepository,
    private twilioVerify?: ITwilioVerifyService,
  ) {}

  async execute(data: CreateWorkerDTO): Promise<Result<InitWorkerOutput>> {
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
          const log = logger.child({
            source: 'InitWorkerUseCase:execute',
            workerId: existingByPhone.id,
          });

          // Usa o phone DA FICHA (não o do payload) para disparar o OTP — anti-hijack.
          const phoneForOtp = existingByPhone.phone ?? phoneInput;
          const phoneE164 = phoneForOtp.startsWith('+')
            ? phoneForOtp
            : `+${normalizePhoneAR(phoneForOtp)}`;

          log.info({
            msg: 'worker_claim_otp_triggered',
            candidateWorkerId: existingByPhone.id,
            fromAuthUid: existingByPhone.authUid,
            phoneE164,
          });

          if (!this.twilioVerify) {
            // Fallback em ambientes sem Twilio configurado (testes de integração E2E
            // que não passam twilioVerify): retorna claim_pending com sid sintético.
            return Result.ok<InitWorkerOutput>({
              status: 'claim_pending',
              candidateWorkerId: existingByPhone.id,
              phoneMasked: maskPhone(phoneE164),
              verificationSid: 'TWILIO_NOT_CONFIGURED',
            });
          }

          try {
            const { verificationSid } =
              await this.twilioVerify.startVerification(phoneE164);

            return Result.ok<InitWorkerOutput>({
              status: 'claim_pending',
              candidateWorkerId: existingByPhone.id,
              phoneMasked: maskPhone(phoneE164),
              verificationSid,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return Result.fail<InitWorkerOutput>(`TWILIO_ERROR:${msg}`);
          }
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
}
