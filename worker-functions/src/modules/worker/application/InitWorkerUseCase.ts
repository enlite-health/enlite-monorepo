import { IWorkerRepository } from '../ports/IWorkerRepository';
import { CreateWorkerDTO, Worker } from '../domain/Worker';
import { InitWorkerOutput } from '../domain/InitWorkerOutput';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';
import { resourceIdHash } from '@shared/audit/resourceAccessLog';
import { generatePhoneCandidates, normalizePhoneAR } from '@shared/utils/phoneNormalization';
import { maskPhone, maskPhoneForLog } from '@shared/utils/phoneMask';
import { isEnliteTestEmail } from '@shared/utils/testAccountEmail';
import { isClaimableWorker, isImportedWorker } from './isClaimableWorker';
import { OTP_CHANNEL_UNAVAILABLE, OTP_RATE_LIMITED, type OtpChallengePort } from '@modules/auth/ports/OtpChallengePort';

/**
 * `emailVerified` vem do token verificado (nunca do corpo): sem ele, o e-mail é só o que
 * a pessoa digitou ao criar a conta e-mail/senha — não prova que ela é dona da ficha.
 */
export interface InitWorkerInput extends CreateWorkerDTO {
  emailVerified: boolean;
  /** `false` (canal app, D734): só acha ou religa a ficha; sem ficha devolve `not_registered`, nada é criado. */
  allowCreate?: boolean;
}

/** Ficha com este e-mail é de outro login e o token não prova posse do e-mail (DP-20). */
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

/** O aceite veio (`lgpdOptIn`) mas a ficha existente não o recebeu: nunca devolve `ok` sem gravar (PR-2/G-6). */
export const CONSENT_NOT_RECORDED = 'CONSENT_NOT_RECORDED';

export class InitWorkerUseCase {
  constructor(
    private workerRepository: IWorkerRepository,
    private otp?: OtpChallengePort,
  ) {}

  /** Aceite da política na ficha existente (COALESCE: o 1º aceite vale). Falha alta: nunca `ok` sem gravar. */
  async recordConsent(workerId: string, at: Date = new Date()): Promise<Result<void>> {
    const saved = await this.workerRepository.recordConsentIfMissing(workerId, at);
    return saved ? Result.ok<void>(undefined) : Result.fail<void>(CONSENT_NOT_RECORDED);
  }

  async execute(data: InitWorkerInput): Promise<Result<InitWorkerOutput>> {
    const consentAt = data.lgpdOptIn ? new Date() : undefined;

    const existingWorkerResult = await this.workerRepository.findByAuthUid(data.authUid);

    if (existingWorkerResult.isFailure) {
      return Result.fail<InitWorkerOutput>(existingWorkerResult.error!);
    }

    if (existingWorkerResult.getValue() !== null) {
      const found = existingWorkerResult.getValue()!;
      // Init pelo app: a ficha já existe, então o aceite entra no MESMO dono do cadastro web (trio em `workers`).
      if (consentAt) {
        const recorded = await this.recordConsent(found.id, consentAt);
        if (recorded.isFailure) return Result.fail<InitWorkerOutput>(recorded.error!);
      }
      // FR-88/C-43: com telefone no payload, a ficha achada por auth_uid passa pelo ramo do telefone.
      if (data.phone) return this.applyPhone(found, data.phone, data.email);
      return Result.ok<InitWorkerOutput>({ status: 'ok', worker: found });
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
          return this.relinkWithoutVerifiedEmail(existingByEmail, data.email);
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
          return this.startClaimOtp(existingByPhone, existingByPhone.phone ?? phoneInput, data.email);
        }
      }
    }

    if (data.allowCreate === false) {
      return Result.ok<InitWorkerOutput>({ status: 'not_registered' });
    }

    const createResult = await this.workerRepository.create({
      authUid: data.authUid,
      email: data.email,
      phone: data.phone,
      whatsappPhone: data.whatsappPhone,
      lgpdOptIn: data.lgpdOptIn,
      country: data.country,
      // C-50/DP-23: conta de E2E nasce is_test no próprio INSERT (e-mail do token, minúsculas).
      isTest: isEnliteTestEmail(data.email),
    });

    if (createResult.isFailure) {
      return Result.fail<InitWorkerOutput>(createResult.error!);
    }

    const worker: Worker = createResult.getValue();

    return Result.ok<InitWorkerOutput>({ status: 'ok', worker });
  }

  /**
   * Telefone de worker já existente (FR-88/C-43). Só grava se a ficha NÃO tinha telefone; o `code`
   * decide a tela no app. Ficha importada com esse celular → OTP do claim; conta real → PHONE_IN_USE.
   */
  private async applyPhone(found: Worker, phoneInput: string, tokenEmail: string): Promise<Result<InitWorkerOutput>> {
    const worker = { ...found, phone: found.phone ? found.phone : null };
    if (worker.phone === null) {
      const normalized = normalizePhoneAR(phoneInput);
      if (normalized.length < 10 || normalized.length > 15) {
        return Result.ok<InitWorkerOutput>({ status: 'phone_rejected', code: 'INVALID_PHONE' });
      }

      const holderResult = await this.workerRepository.findByPhoneCandidates(generatePhoneCandidates(phoneInput));
      if (holderResult.isFailure) return Result.fail<InitWorkerOutput>(holderResult.error!);
      const holder = holderResult.getValue();
      if (holder !== null && holder.id !== found.id) {
        if (!isImportedWorker(holder.authUid)) {
          return Result.ok<InitWorkerOutput>({ status: 'phone_rejected', code: 'PHONE_IN_USE' });
        }
        const claim = await this.startClaimOtp(holder, holder.phone ?? phoneInput, tokenEmail);
        if (claim.isFailure) return claim;
        return Result.ok<InitWorkerOutput>({ ...(claim.getValue() as InitWorkerOutput & { status: 'claim_pending' }), code: 'CLAIM_PENDING' });
      }

      let saved: Worker | null;
      try {
        saved = await this.workerRepository.setPhoneIfNull(found.id, normalized);
      } catch (err: unknown) {
        // DT-51: corrida de duas contas no mesmo celular. A mensagem do Postgres ecoa a linha (PII):
        // nunca entra na resposta nem no log; só o código e o hash do id.
        const pg = err as { code?: string; constraint?: string };
        const log = logger.child({ source: 'InitWorkerUseCase:applyPhone', workerIdHash: resourceIdHash(found.id) });
        if (pg.code === '23505' && pg.constraint === 'idx_workers_phone_unique') {
          log.warn({ msg: 'worker_phone_unique_violation' });
          return Result.ok<InitWorkerOutput>({ status: 'phone_rejected', code: 'PHONE_IN_USE' });
        }
        log.error({ msg: 'worker_phone_update_failed', pgCode: pg.code });
        return Result.fail<InitWorkerOutput>('PHONE_UPDATE_FAILED');
      }
      if (saved === null) return Result.ok<InitWorkerOutput>({ status: 'ok', worker: found, code: 'PHONE_LOCKED' });
      return Result.ok<InitWorkerOutput>({ status: 'ok', worker: saved, code: 'OK' });
    }
    // Ficha com telefone: o MESMO número é idempotente (OK, nada gravado); outro número → PHONE_LOCKED.
    const same = normalizePhoneAR(worker.phone) === normalizePhoneAR(phoneInput);
    return Result.ok<InitWorkerOutput>({ status: 'ok', worker: found, code: same ? 'OK' : 'PHONE_LOCKED' });
  }

  /**
   * Ficha achada por e-mail, de outro login, e token sem `email_verified` (DP-20). Ficha
   * reclamável COM telefone → `claim_pending` (OTP ao telefone dela; o front já abre o modal).
   * Sem telefone, ou não reclamável (login real, `talentum_`, sobrevivente que absorveu login
   * real: o confirm do claim recusaria) → EMAIL_NOT_VERIFIED. Nunca religa nem cria ficha.
   */
  private async relinkWithoutVerifiedEmail(ficha: Worker, tokenEmail: string): Promise<Result<InitWorkerOutput>> {
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
    return this.startClaimOtp(ficha, ficha.phone, tokenEmail);
  }

  /** OTP ao telefone DA FICHA (nunca o do payload — anti-hijack) e `claim_pending`. */
  private async startClaimOtp(ficha: Worker, phoneForOtp: string, tokenEmail: string): Promise<Result<InitWorkerOutput>> {
    const phoneE164 = phoneForOtp.startsWith('+') ? phoneForOtp : `+${normalizePhoneAR(phoneForOtp)}`;

    logger.child({ source: 'InitWorkerUseCase:execute', workerId: ficha.id }).info({
      msg: 'worker_claim_otp_triggered',
      candidateWorkerId: ficha.id,
      fromAuthUid: ficha.authUid,
      phoneE164: maskPhoneForLog(phoneE164),
    });

    if (!this.otp) {
      // Fallback em ambientes sem Twilio configurado (testes de integração E2E
      // que não passam o port de OTP): retorna claim_pending com sid sintético.
      return Result.ok<InitWorkerOutput>({
        status: 'claim_pending',
        candidateWorkerId: ficha.id,
        phoneMasked: maskPhone(phoneE164),
        verificationSid: 'TWILIO_NOT_CONFIGURED',
      });
    }

    try {
      const { challengeId: verificationSid } = await this.otp.start({
        workerId: ficha.id,
        purpose: 'claim',
        phoneE164,
        ctx: { workerId: ficha.id, fichaIsTest: ficha.isTest === true, tokenEmail },
      });
      return Result.ok<InitWorkerOutput>({
        status: 'claim_pending',
        candidateWorkerId: ficha.id,
        phoneMasked: maskPhone(phoneE164),
        verificationSid,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === OTP_RATE_LIMITED || msg === OTP_CHANNEL_UNAVAILABLE) return Result.fail<InitWorkerOutput>(msg);
      return Result.fail<InitWorkerOutput>(`TWILIO_ERROR:${msg}`);
    }
  }
}
