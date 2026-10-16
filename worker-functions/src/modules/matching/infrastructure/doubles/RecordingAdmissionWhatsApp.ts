import { randomUUID } from 'crypto';
import { Result } from '@shared/utils/Result';
import type { MessageSentResult } from '@modules/notification/domain/IMessagingService';
import type { AdmissionWhatsAppSender } from '../admissionTemplates';

/** Dublê do canal WhatsApp: nada sai da máquina; guarda as chamadas e devolve um SID sintético (ou falha, se mandado). */
export class RecordingAdmissionWhatsApp implements AdmissionWhatsAppSender {
  readonly calls: { to: string; contentSid: string; vars: Record<string, string> }[] = [];
  failWith: string | null = null;
  /** SID sintético ÚNICO por instância: `admission_messages.twilio_sid` é UNIQUE e o banco de teste sobrevive entre rodadas. */
  private readonly sidPrefix = `SMFAKE${randomUUID().slice(0, 8)}`;

  async sendWithContentSid(to: string, contentSid: string, vars: Record<string, string>): Promise<Result<MessageSentResult>> {
    this.calls.push({ to, contentSid, vars });
    if (this.failWith) return Result.fail<MessageSentResult>(this.failWith);
    return Result.ok<MessageSentResult>({ externalId: `${this.sidPrefix}-${this.calls.length}`, status: 'queued', to });
  }
}
