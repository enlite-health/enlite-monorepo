import crypto from 'crypto';
import twilio from 'twilio';
import { logger, reportError } from '@shared/logging';
import { maskPhoneForLog } from '@shared/utils/phoneMask';

/**
 * E2E OTP bypass — APENAS pra dev local.
 *
 * Quando `E2E_OTP_BYPASS=true` E ambiente NÃO é Cloud Run, startVerification retorna
 * um sid sintético `TEST_<uuid>` sem tocar no Twilio (zero custo, sem SMS real).
 * checkVerification valida code contra `E2E_OTP_CODE` (default '123456').
 *
 * Detecção de Cloud Run: a env var `K_SERVICE` é setada automaticamente pela runtime
 * do Cloud Run com o nome do serviço, e NUNCA está presente em dev local. Mesmo que
 * o dev local aponte pra `GCP_PROJECT_ID=enlite-prd` (Firebase Auth real), `K_SERVICE`
 * não vaza pra lá. Se a flag vazar pro Cloud Run, é ignorada + erro reportado.
 */
function detectE2EBypass(): boolean {
  if (process.env.E2E_OTP_BYPASS !== 'true') return false;

  // K_SERVICE só existe na runtime do Cloud Run (também GKE Workload Identity)
  const isCloudRun = !!process.env.K_SERVICE;

  if (isCloudRun) {
    logger.error({
      source: 'TwilioVerifyService:bootstrap',
      msg: 'otp_bypass_leaked_to_production',
      kService: process.env.K_SERVICE,
      kRevision: process.env.K_REVISION ?? null,
      gcpProjectId: process.env.GCP_PROJECT_ID ?? null,
    });
    reportError(new Error('E2E_OTP_BYPASS=true detected in Cloud Run runtime — ignored'), {
      source: 'TwilioVerifyService:bootstrap',
    });
    return false;
  }

  logger.warn({
    source: 'TwilioVerifyService:bootstrap',
    msg: 'otp_bypass_enabled',
    nodeEnv: process.env.NODE_ENV ?? null,
    gcpProjectId: process.env.GCP_PROJECT_ID ?? null,
  });
  return true;
}

const TEST_SID_PREFIX = 'TEST_';

export interface ITwilioVerifyService {
  startVerification(phoneE164: string): Promise<{ verificationSid: string }>;
  checkVerification(
    verificationSid: string,
    code: string,
  ): Promise<{ valid: boolean; status: 'approved' | 'pending' | 'expired' | 'canceled' }>;
}

/**
 * Twilio Verify para OTP de claim de ficha importada.
 *
 * Canal atual: SMS. Migração para WhatsApp pendente — requer que o WhatsApp Sender
 * (waba_id 4410859772526279, +14788003312) esteja online no Twilio + Messaging
 * Service configurado. Atualmente offline (code 63111). Quando reativado,
 * trocar `channel: 'sms'` por `'whatsapp'` e configurar TWILIO_VERIFY_TEMPLATE_SID
 * opcional com Content Template SID aprovado pela Meta.
 *
 * Variáveis de ambiente obrigatórias:
 *   TWILIO_ACCOUNT_SID          — Twilio Account SID
 *   TWILIO_AUTH_TOKEN           — Twilio Auth Token
 *   TWILIO_VERIFY_SERVICE_SID   — Verify Service SID (prefixo VA)
 */
export class TwilioVerifyService implements ITwilioVerifyService {
  private readonly client: ReturnType<typeof twilio> | null;
  private readonly serviceSid: string;
  private readonly isConfigured: boolean;
  private readonly bypassE2E: boolean;
  private readonly bypassExpectedCode: string;

  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    this.serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID ?? '';

    this.isConfigured = !!(accountSid && authToken && this.serviceSid);
    this.bypassE2E = detectE2EBypass();
    this.bypassExpectedCode = process.env.E2E_OTP_CODE ?? '123456';

    if (this.isConfigured) {
      this.client = twilio(accountSid!, authToken!);
    } else {
      this.client = null;
      logger.warn({
        msg: 'TwilioVerifyService not configured — TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_VERIFY_SERVICE_SID missing',
      });
    }
  }

  async startVerification(phoneE164: string): Promise<{ verificationSid: string }> {
    const phoneMasked = maskPhoneForLog(phoneE164);
    const log = logger.child({
      source: 'TwilioVerifyService:start',
      phoneMasked,
      channel: this.bypassE2E ? 'bypass' : 'sms',
    });

    // E2E bypass — retorna sid sintético sem tocar no Twilio.
    if (this.bypassE2E) {
      const verificationSid = `${TEST_SID_PREFIX}${crypto.randomUUID()}`;
      log.info({ msg: 'otp_started_bypass', verificationSid });
      return { verificationSid };
    }

    if (!this.isConfigured || !this.client) {
      log.error({ msg: 'otp_start_skipped_not_configured' });
      throw new Error('TwilioVerifyService not configured');
    }

    const startedAt = Date.now();

    try {
      const verification = await this.client.verify.v2
        .services(this.serviceSid)
        .verifications.create({ to: phoneE164, channel: 'sms' });

      const durationMs = Date.now() - startedAt;

      // Log estruturado pra diagnóstico: muito usuário reclama "não recebi código"
      // ou "código não funciona". Esses campos permitem rastrear no Cloud Logging:
      //   - resource.type=cloud_run_revision AND jsonPayload.msg="otp_started"
      //   - filtros por verificationSid pra ver o ciclo de vida completo
      log.info({
        msg: 'otp_started',
        verificationSid: verification.sid,
        twilioStatus: verification.status,        // 'pending' = enviado com sucesso
        sendCodeAttempts: verification.sendCodeAttempts ?? null,
        durationMs,
        validUntil: verification.dateUpdated ? new Date(verification.dateUpdated.getTime() + 10 * 60_000).toISOString() : null,
      });

      return { verificationSid: verification.sid };
    } catch (err: unknown) {
      const durationMs = Date.now() - startedAt;
      const e = err instanceof Error ? err : new Error(String(err));
      // Twilio errors trazem `.code` e `.status` no payload — capturar pra debug
      const twilioCode = (err as { code?: number | string }).code ?? null;
      const twilioStatus = (err as { status?: number }).status ?? null;
      log.error({
        msg: 'otp_start_failed',
        durationMs,
        twilioCode,
        twilioStatus,
        errorMessage: e.message,
      });
      reportError(e, {
        source: 'TwilioVerifyService:start',
        phoneMasked,
        twilioCode: twilioCode != null ? String(twilioCode) : null,
      });
      throw e;
    }
  }

  async checkVerification(
    verificationSid: string,
    code: string,
  ): Promise<{ valid: boolean; status: 'approved' | 'pending' | 'expired' | 'canceled' }> {
    // PII-safe: NUNCA logar o código completo. Só metadados pra diagnóstico:
    //   - length: detecta usuário digitando incompleto
    //   - hasNonDigit: detecta usuário colando texto extra (espaço, "código:", etc.)
    const codeLength = code.length;
    const hasNonDigit = /\D/.test(code);

    const log = logger.child({
      source: 'TwilioVerifyService:check',
      verificationSid,
      codeLength,
      hasNonDigit,
      channel: this.bypassE2E ? 'bypass' : 'sms',
    });

    // E2E bypass — só aceita sids sintéticos (gerados pelo próprio bypass);
    // sids reais TWILIO sempre caem no caminho normal.
    if (this.bypassE2E && verificationSid.startsWith(TEST_SID_PREFIX)) {
      const valid = code === this.bypassExpectedCode;
      const status: 'approved' | 'pending' = valid ? 'approved' : 'pending';
      log.info({ msg: 'otp_checked_bypass', valid, status });
      return { valid, status };
    }

    if (!this.isConfigured || !this.client) {
      log.error({ msg: 'otp_check_skipped_not_configured' });
      throw new Error('TwilioVerifyService not configured');
    }

    const startedAt = Date.now();

    try {
      const check = await this.client.verify.v2
        .services(this.serviceSid)
        .verificationChecks.create({ verificationSid, code });

      const rawStatus = check.status as string;
      const status = (['approved', 'pending', 'expired', 'canceled'].includes(rawStatus)
        ? rawStatus
        : 'canceled') as 'approved' | 'pending' | 'expired' | 'canceled';

      const valid = status === 'approved';
      const durationMs = Date.now() - startedAt;

      // Log estruturado — pra debug "digitei o código certo e não funcionou":
      //   - status='pending' = código errado (Twilio aceita retry)
      //   - status='approved' = sucesso
      //   - status='canceled' = max tentativas excedido (5 padrão)
      //   - status='expired' = > 10 min do start
      log.info({
        msg: 'otp_checked',
        valid,
        status,
        durationMs,
        twilioAmount: check.amount ?? null,
        twilioPayee: check.payee ?? null,
      });

      return { valid, status };
    } catch (err: unknown) {
      const durationMs = Date.now() - startedAt;
      const e = err instanceof Error ? err : new Error(String(err));
      const twilioCode = (err as { code?: number | string }).code ?? null;
      const twilioStatus = (err as { status?: number }).status ?? null;
      // 20404 = verification not found (expirou ou nunca existiu)
      // 60202 = max check attempts reached
      log.warn({
        msg: 'otp_check_failed',
        durationMs,
        twilioCode,
        twilioStatus,
        errorMessage: e.message,
      });
      // Não chama reportError aqui — código errado é comportamento normal de usuário,
      // não erro de sistema. Só loga warn pra rastreio.
      throw e;
    }
  }
}

