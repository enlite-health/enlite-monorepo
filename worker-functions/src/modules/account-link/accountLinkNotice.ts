/**
 * accountLinkNotice — email de aviso à conta ABSORVIDA após o vínculo.
 *
 * Proteção contra número reciclado/SIM swap sem OTP de email obrigatório
 * (D85): quem NÃO fez o vínculo descobre por aqui e reverte com 1 clique
 * (link assinado, 7 dias → undo por auditoria).
 *
 * Best-effort: falha de email NUNCA desfaz o merge — registra o skip no
 * funil (account_link_events) e no log.
 */

import type { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';
import { EmailChannelUnavailableError, EmailService } from '../identity/infrastructure/EmailService';
import { signLinkToken, UNDO_TOKEN_TTL_MS } from './linkToken';
import { recordAccountLinkEvent } from './accountLinkEvents';

const log = () => logger.child({ source: 'accountLinkNotice' });

export async function sendLinkedNoticeEmail(
  pool: Pool,
  params: { survivorId: string; absorbedId: string; mergeAuditId: number },
): Promise<void> {
  const { survivorId, absorbedId, mergeAuditId } = params;

  const res = await pool.query<{ email: string | null }>(
    `SELECT email FROM workers WHERE id = $1::uuid`, [absorbedId],
  );
  const email = res.rows[0]?.email ?? null;

  // Sem email real (ou sintético de import) → não há quem avisar; registra.
  if (!email || email.toLowerCase().endsWith('@enlite.import')) {
    await recordAccountLinkEvent(pool, {
      event: 'notice_email_skipped', workerId: survivorId, otherWorkerId: absorbedId,
      mergeAuditId, detail: { reason: 'no_real_email' },
    });
    return;
  }

  try {
    const token = signLinkToken({
      purpose: 'undo', survivorId, absorbedId, mergeAuditId,
      exp: Date.now() + UNDO_TOKEN_TTL_MS,
    });
    const base = process.env.ACCOUNT_LINK_PUBLIC_BASE_URL
      ?? 'https://api.enlite.health';
    const undoUrl = `${base}/api/account-link/undo/${token}`;

    await new EmailService().sendAccountLinkedNotice(email, { undoUrl });

    await recordAccountLinkEvent(pool, {
      event: 'notice_email_sent', workerId: survivorId, otherWorkerId: absorbedId, mergeAuditId,
    });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    // "Não havia canal" (teste, ou serviço sem SENDGRID_API_KEY) NÃO é erro: não
    // vai para o Error Reporting e a trilha registra o motivo pelo que ele é.
    // Antes os dois casos viravam a mesma linha `send_failed`, e quem lesse a
    // trilha não sabia se o SendGrid recusou ou se nem existia canal.
    const semCanal = e instanceof EmailChannelUnavailableError;
    if (!semCanal) reportError(e, { source: 'accountLinkNotice', mergeAuditId });
    log().error({ msg: 'account_link_notice_failed', mergeAuditId, reason: e.message });
    await recordAccountLinkEvent(pool, {
      event: 'notice_email_skipped', workerId: survivorId, otherWorkerId: absorbedId,
      mergeAuditId, detail: { reason: semCanal ? 'no_email_channel' : 'send_failed' },
    });
  }
}
