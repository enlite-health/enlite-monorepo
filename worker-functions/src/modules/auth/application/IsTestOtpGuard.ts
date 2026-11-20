import crypto from 'crypto';
import { logger } from '@shared/logging';
import { isEnliteTestEmail } from '@shared/utils/testAccountEmail';
import type { ITwilioVerifyService, OtpCheckResult, OtpSendContext } from '../infrastructure/TwilioVerifyService';

/**
 * FR-95/DP-23: o OTP de ficha `is_test` não sai pelo Twilio.
 *
 * Suprime SÓ quando as DUAS condições valem: a ficha que recebe o código é `is_test` E o
 * e-mail do token é `@enlite.test`. Ficha real com token de teste, ou ficha de teste com token
 * real, seguem pelo envio normal — o atalho nunca vale para ficha de pessoa de verdade.
 */
export function shouldSuppressOtp(ctx?: OtpSendContext): boolean {
  if (ctx && ctx.fichaIsTest === true && isEnliteTestEmail(ctx.tokenEmail)) {
    return true;
  }
  return false;
}

const SUPPRESSED_SID_PREFIX = 'SUPPRESSED_';

/** Uma chave por processo: todas as instâncias da guarda no mesmo processo se entendem. */
const PROCESS_KEY = crypto.randomBytes(32).toString('hex');

/**
 * O sid suprimido carrega o telefone CIFRADO e autenticado (AES-256-GCM): o confirm amarra o
 * código ao telefone da ficha (DP-21) sem estado — Cloud Run tem várias instâncias, start e
 * confirm podem cair em instâncias diferentes — e sem forja (sid inventado para o telefone de
 * uma ficha REAL não decifra). Opaco de propósito: o sid vai para log e trilha, o telefone não.
 */
function sealPhone(key: string, phone: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv);
  const ct = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

function parseSuppressedSid(key: string, sid: string): { to: string } | null {
  if (!sid.startsWith(SUPPRESSED_SID_PREFIX)) return null;
  try {
    const raw = Buffer.from(sid.slice(SUPPRESSED_SID_PREFIX.length), 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const to = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    return { to };
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
  ) {}

  async startVerification(phoneE164: string, ctx?: OtpSendContext): Promise<{ verificationSid: string }> {
    if (!shouldSuppressOtp(ctx)) return this.inner.startVerification(phoneE164, ctx);

    const verificationSid = `${SUPPRESSED_SID_PREFIX}${sealPhone(this.signingKey, phoneE164)}`;
    logger.child({ source: 'IsTestOtpGuard:start' }).info({ msg: 'otp_suppressed_is_test' });
    return { verificationSid };
  }

  async checkVerification(verificationSid: string, code: string): Promise<OtpCheckResult> {
    const suppressed = parseSuppressedSid(this.signingKey, verificationSid);
    if (!suppressed) return this.inner.checkVerification(verificationSid, code);

    const expected = this.expectedCode();
    const valid = Boolean(expected) && code === expected;
    return { valid, status: valid ? 'approved' : 'pending', to: suppressed.to };
  }
}
