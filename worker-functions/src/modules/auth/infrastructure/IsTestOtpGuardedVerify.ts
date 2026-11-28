import crypto from 'crypto';
import { logger } from '@shared/logging';
import { isEnliteTestEmail } from '@shared/utils/testAccountEmail';
import { shouldSuppressOtp } from '../application/IsTestOtpGuard';
import type { OtpConfirmContext, OtpSendContext } from '../ports/OtpChallengePort';
import type { ITwilioVerifyService, OtpCheckResult } from './TwilioVerifyService';

const SUPPRESSED_SID_PREFIX = 'SUPPRESSED_';

/** Uma chave por processo: todas as instâncias da guarda no mesmo processo se entendem. */
const PROCESS_KEY = crypto.randomBytes(32).toString('hex');

/** Validade do código suprimido: a mesma do Twilio Verify (10 min). */
const SUPPRESSED_TTL_MS = 10 * 60_000;

interface SealedSuppression {
  /** Telefone da ficha (DP-21: o confirm amarra o código a ele). */
  to: string;
  /** Ficha ALVO do envio: o confirm com outro workerId é recusado. */
  workerId: string;
  expiresAt: number;
}

/**
 * O sid suprimido carrega telefone, workerId alvo e validade CIFRADOS e autenticados (AES-256-GCM):
 * o confirm confere tudo sem estado — Cloud Run tem várias instâncias, start e confirm podem cair
 * em instâncias diferentes — e sem forja (sid inventado não decifra). Opaco de propósito: o sid vai
 * para log e trilha, o telefone não.
 */
function seal(key: string, payload: SealedSuppression): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

function parseSuppressedSid(key: string, sid: string): SealedSuppression | null {
  if (!sid.startsWith(SUPPRESSED_SID_PREFIX)) return null;
  try {
    const raw = Buffer.from(sid.slice(SUPPRESSED_SID_PREFIX.length), 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    const p = JSON.parse(json) as Partial<SealedSuppression>;
    if (typeof p.to !== 'string' || typeof p.workerId !== 'string' || typeof p.expiresAt !== 'number') return null;
    return { to: p.to, workerId: p.workerId, expiresAt: p.expiresAt };
  } catch {
    return null;
  }
}

/**
 * PONTO ÚNICO de envio do código: decora a porta de verificação (hoje `TwilioVerifyService`;
 * o adapter do PR-INF-46 entra no lugar de `inner` sem mudar nada aqui). Todo chamador que
 * dispara OTP passa por esta porta — a decisão não fica espalhada pelos casos de uso, que só
 * informam os fatos (`OtpSendContext`).
 *
 * Suprimido: nenhuma chamada a `inner`; sid sintético; o código válido é o de `E2E_OTP_CODE`
 * (secret `e2e-otp-code-prd` montado no serviço). Sem a env, nenhum código é aceito (falha fechada).
 */
export class IsTestOtpGuardedVerify implements ITwilioVerifyService {
  constructor(
    private readonly inner: ITwilioVerifyService,
    private readonly expectedCode: () => string | undefined = () => process.env.E2E_OTP_CODE,
    /** Sem `TWILIO_AUTH_TOKEN` (dev), chave aleatória do processo: o sid só vale nesta instância. */
    private readonly signingKey: string = process.env.TWILIO_AUTH_TOKEN || PROCESS_KEY,
    private readonly now: () => number = Date.now,
  ) {}

  async startVerification(phoneE164: string, ctx?: OtpSendContext): Promise<{ verificationSid: string }> {
    if (!shouldSuppressOtp(ctx)) return this.inner.startVerification(phoneE164, ctx);

    const verificationSid = `${SUPPRESSED_SID_PREFIX}${seal(this.signingKey, {
      to: phoneE164,
      workerId: ctx!.workerId,
      expiresAt: this.now() + SUPPRESSED_TTL_MS,
    })}`;
    logger.child({ source: 'IsTestOtpGuard:start' }).info({ msg: 'otp_suppressed_is_test' });
    return { verificationSid };
  }

  async checkVerification(verificationSid: string, code: string, ctx?: OtpConfirmContext): Promise<OtpCheckResult> {
    const sealed = parseSuppressedSid(this.signingKey, verificationSid);
    if (!sealed) return this.inner.checkVerification(verificationSid, code);

    // O CONFIRM exige de novo as duas condições do envio e que seja a MESMA ficha: o `workerId` do
    // confirm vem do cliente (corpo do claim). Qualquer falha = o mesmo "código inválido" de um
    // código errado — quem tenta não aprende qual condição falhou.
    const refuse = (reason: string): OtpCheckResult => {
      logger.child({ source: 'IsTestOtpGuard:check' }).warn({ msg: 'otp_suppressed_confirm_refused', reason });
      return { valid: false, status: 'pending' };
    };
    if (!ctx) return refuse('no_context');
    if (this.now() > sealed.expiresAt) return refuse('expired');
    if (ctx.workerId !== sealed.workerId) return refuse('other_worker');
    if (!isEnliteTestEmail(ctx.tokenEmail)) return refuse('token_not_test');
    if (!(await ctx.fichaIsTest())) return refuse('ficha_not_test');

    const expected = this.expectedCode();
    if (!expected) {
      logger.child({ source: 'IsTestOtpGuard:check' }).error({ msg: 'otp_test_code_missing' });
      return { valid: false, status: 'pending' };
    }
    const valid = code === expected;
    return { valid, status: valid ? 'approved' : 'pending', to: sealed.to };
  }
}
