import sgMail from '@sendgrid/mail';
import { logger } from '@shared/logging';

/**
 * Transactional email service backed by SendGrid.
 * Sender identity (`EMAIL_FROM`) must be verified in the SendGrid account
 * (Single Sender Verification or Domain Authentication).
 *
 * ⚠️ GUARD DE ENVIO (17/08/2026) — achado em revisão, medido: o e2e estava
 * mandando requisição HTTPS de VERDADE para `api.sendgrid.com`. Ela só não
 * virava e-mail porque a chave do CI não existe e a API devolvia 401 — proteção
 * por acaso, não por desenho. Numa máquina com `SENDGRID_API_KEY` exportada (um
 * `.env` de dev carregado), o e2e mandaria e-mail real para o endereço do
 * fixture. Ver memória `teste-nunca-toca-canal-real`.
 *
 * O construtor já pulava o `setApiKey` sem chave, mas o `send` disparava assim
 * mesmo: o SDK não se recusa a tentar. Agora `canSend()` decide ANTES de chamar
 * o SDK — e LANÇA `EmailChannelUnavailableError` em vez de voltar calado.
 *
 * ⚠️ Lançar é decisão, não descuido: quem chama já trata falha de envio
 * registrando o skip na trilha (`accountLinkNotice.ts:54-61` grava
 * `notice_email_skipped`). Voltar em silêncio faria a trilha afirmar que o
 * aviso saiu quando não saiu — best-effort silencioso, que esta casa proíbe
 * (memória `canal-de-aviso-so-oficial`). O erro TIPADO é o que deixa o motivo
 * distinguível de uma falha real do SendGrid.
 */

/** Não há canal de e-mail neste processo — não é falha do SendGrid. */
export class EmailChannelUnavailableError extends Error {
  constructor(public readonly motivo: 'ambiente de teste' | 'sem SENDGRID_API_KEY') {
    super(`[email] envio não realizado — ${motivo}`);
    this.name = 'EmailChannelUnavailableError';
  }
}
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export class EmailService {
  private readonly fromEmail: string;
  private readonly fromName = 'Enlite';

  constructor() {
    this.fromEmail = process.env.EMAIL_FROM || 'enlite@enlite.health';
    const apiKey = process.env.SENDGRID_API_KEY;
    if (apiKey) {
      sgMail.setApiKey(apiKey);
    }
  }

  async sendInvitationEmail(to: string, name: string, inviteLink: string): Promise<void> {
    await this.send({
      to,
      subject: 'Fuiste invitado a Enlite — Definí tu contraseña',
      html: this.buildPasswordLinkHtml(name, inviteLink, 'Bienvenido/a a Enlite', 'Definir contraseña'),
    });
  }

  async sendPasswordResetEmail(to: string, name: string, resetLink: string): Promise<void> {
    await this.send({
      to,
      subject: 'Restablecimiento de contraseña - Enlite',
      html: this.buildPasswordLinkHtml(name, resetLink, 'Restablecimiento de contraseña', 'Restablecer contraseña'),
    });
  }

  /**
   * Aviso à conta ABSORVIDA num vínculo self-service de contas (colisão de
   * telefone). Primeiro email worker-facing do serviço — o undo de 7 dias é a
   * proteção contra número reciclado/SIM swap no lugar de OTP de email (D85).
   */
  async sendAccountLinkedNotice(to: string, params: { undoUrl: string }): Promise<void> {
    await this.send({
      to,
      subject: 'Tu cuenta de Enlite fue vinculada a otra cuenta',
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:'Poppins',Arial,sans-serif;background:#FFF9FC;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(24,1,73,0.08);">
    <div style="background:#180149;padding:32px 24px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;font-family:'Lexend',Arial,sans-serif;">Tu cuenta fue vinculada</h1>
    </div>
    <div style="padding:32px 24px;">
      <p style="color:#333;font-size:14px;">Alguien verificó por SMS la posesión del número de teléfono de esta cuenta
      y la vinculó a otra cuenta de Enlite. Tus postulaciones y documentos se conservaron en la cuenta unificada.</p>
      <p style="color:#333;font-size:14px;"><strong>¿Fuiste vos?</strong> No hace falta hacer nada.</p>
      <p style="color:#333;font-size:14px;"><strong>¿No fuiste vos?</strong> Revertí el vínculo con un clic
      (válido por 7 días). La reversión restaura tu cuenta al estado exacto del momento del vínculo.</p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${params.undoUrl}"
           style="display:inline-block;background:#180149;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:bold;font-family:'Lexend',Arial,sans-serif;">No fui yo — revertir</a>
      </div>
      <p style="color:#888;font-size:12px;">Si el botón no funciona, copiá este enlace: ${params.undoUrl}</p>
    </div>
  </div>
</body>
</html>`,
    });
  }

  /**
   * Spec 069 F4 — resumo diário "Turnos sin cubrir" ao staff que monta o itinerário. Um e-mail por destinatário e dia, em es (UI da
   * operação): paciente (nome de exibição pela projeção do Kanban), serviço, nº de turnos, 1º dia e link para a aba do serviço.
   * NADA clínico. Passa por `assertCanSend` (via `send`): `NODE_ENV=test`/sem chave NUNCA envia (`EmailChannelUnavailableError`).
   */
  async sendItineraryUncoveredShiftsDigest(
    to: string,
    items: ReadonlyArray<{ patientId: string; patientName: string; serviceId: string; serviceCode: string; shifts: number; firstDate: string }>,
    operationDate: string,
    horizonDays: number,
  ): Promise<void> {
    const base = 'https://app.enlite.health';
    const total = items.reduce((sum, i) => sum + i.shifts, 0);
    const rows = items
      .map((i) => {
        const link = `${base}/admin/patients/${encodeURIComponent(i.patientId)}?tab=itinerary&serviceId=${encodeURIComponent(i.serviceId)}`;
        return `<tr>
          <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:14px;color:#333;">${escapeHtml(i.patientName)}</td>
          <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:14px;color:#333;">${escapeHtml(i.serviceCode)}</td>
          <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:14px;color:#333;text-align:center;">${i.shifts}</td>
          <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:14px;color:#333;">${escapeHtml(i.firstDate)}</td>
          <td style="padding:8px 6px;border-bottom:1px solid #eee;font-size:14px;"><a href="${link}" style="color:#180149;">Abrir</a></td>
        </tr>`;
      })
      .join('');
    await this.send({
      to,
      subject: `Turnos sin cubrir: ${total} en los próximos ${horizonDays} días`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:'Poppins',Arial,sans-serif;background:#FFF9FC;">
  <div style="max-width:640px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(24,1,73,0.08);">
    <div style="background:#180149;padding:24px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:20px;font-family:'Lexend',Arial,sans-serif;">Turnos sin cubrir</h1>
    </div>
    <div style="padding:24px;">
      <p style="color:#333;font-size:14px;">Al ${escapeHtml(operationDate)} hay <strong>${total}</strong> turno(s) sin cubrir en los próximos ${horizonDays} días, en ${items.length} servicio(s):</p>
      <table style="width:100%;border-collapse:collapse;">
        <tr><th align="left" style="font-size:12px;color:#666;">Paciente</th><th align="left" style="font-size:12px;color:#666;">Servicio</th><th style="font-size:12px;color:#666;">Turnos</th><th align="left" style="font-size:12px;color:#666;">Desde</th><th></th></tr>
        ${rows}
      </table>
    </div>
  </div>
</body>
</html>`,
    });
  }

  /**
   * `false` = não existe canal para este processo. Duas condições, e as duas
   * precisam ser explícitas:
   *   · sem `SENDGRID_API_KEY` não há como enviar (e o SDK tentaria mesmo assim);
   *   · em `NODE_ENV=test` NUNCA se envia, mesmo com chave — é o teste que não
   *     pode tocar canal real, independente de quem exportou o quê no shell.
   */
  private assertCanSend(subject: string): void {
    const motivo =
      process.env.NODE_ENV === 'test'
        ? ('ambiente de teste' as const)
        : !process.env.SENDGRID_API_KEY
          ? ('sem SENDGRID_API_KEY' as const)
          : null;
    if (!motivo) return;
    // Sem destinatário no log (é PII) — só o motivo e o assunto.
    logger.warn({ subject, motivo }, '[email] envio NÃO realizado — canal indisponível neste processo');
    throw new EmailChannelUnavailableError(motivo);
  }

  private async send(msg: { to: string; subject: string; html: string }): Promise<void> {
    this.assertCanSend(msg.subject);
    await sgMail.send({
      to: msg.to,
      from: { email: this.fromEmail, name: this.fromName },
      subject: msg.subject,
      html: msg.html,
    });
  }

  private buildPasswordLinkHtml(name: string, link: string, title: string, cta: string): string {
    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:'Poppins',Arial,sans-serif;background:#FFF9FC;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(24,1,73,0.08);">
    <div style="background:#180149;padding:32px 24px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:24px;font-family:'Lexend',Arial,sans-serif;">${title}</h1>
    </div>
    <div style="padding:32px 24px;">
      <p style="color:#333;font-size:16px;">Hola <strong>${name}</strong>,</p>
      <p style="color:#333;font-size:14px;">Hacé clic en el botón para ${cta.toLowerCase()} y acceder a la plataforma:</p>
      <div style="text-align:center;margin:32px 0;">
        <a href="${link}"
           style="display:inline-block;background:#180149;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:bold;font-family:'Lexend',Arial,sans-serif;">
          ${cta}
        </a>
      </div>
      <p style="color:#666;font-size:13px;">Si el botón no funciona, copiá este enlace en tu navegador:</p>
      <p style="color:#180149;font-size:12px;word-break:break-all;">${link}</p>
      <p style="color:#999;font-size:12px;margin-top:32px;">Si no esperabas este correo, podés ignorarlo.</p>
    </div>
  </div>
</body>
</html>`;
  }
}
