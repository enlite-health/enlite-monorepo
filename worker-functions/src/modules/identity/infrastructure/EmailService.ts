import sgMail from '@sendgrid/mail';

/**
 * Transactional email service backed by SendGrid.
 * Sender identity (`EMAIL_FROM`) must be verified in the SendGrid account
 * (Single Sender Verification or Domain Authentication).
 */
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

  private async send(msg: { to: string; subject: string; html: string }): Promise<void> {
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
