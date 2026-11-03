import type { PoolClient } from 'pg';
import type { AdmissionImportBlockedKind } from '@modules/inapp-notification/infrastructure/NotificationRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { supervisorEmails } from '../domain/admissionImportNoticeConfig';
import type { AdmissionLogger } from './AdmissionMessagingService';
import type { ImportBlockNotice, ImportBlockNoticePort } from './ports/ImportPorts';

/** Leitura de destinatário (implementada por `infrastructure/ImportNoticeRepository`). */
export interface ImportNoticeRecipients {
  activeUidByEmail(email: string, ex: PoolClient): Promise<string | null>;
  hostDisplayName(email: string, ex: PoolClient): Promise<string | null>;
}

type NoticeBase = Pick<Parameters<SystemNotificationPublisher['publishAdmissionImportBlocked']>[1]['payload'], 'kind' | 'reason' | 'meetingAt' | 'deadlineAt'>;

export interface ImportBlockNotifierDeps {
  kind: AdmissionImportBlockedKind;
  /** Prefixo do log (`admission` | `enquadre`). */
  prefix: string;
  publisher: Pick<SystemNotificationPublisher, 'publishAdmissionImportBlocked'>;
  recipients: ImportNoticeRecipients;
  log: AdmissionLogger;
  /** Lista da gestão (padrão: env `ADMISSION_IMPORT_SUPERVISOR_EMAILS`). */
  supervisors?: () => ReturnType<typeof supervisorEmails>;
}

/**
 * Aviso no sino da importação bloqueada (spec 083, D-5): o HOST recebe as etapas `blocked`/`reminder`/`expired`; a GESTÃO recebe UM
 * `will_be_lost` (só quando `warnManagement`), e nada se o uid dela for o do host. Tudo na transação do chamador. Falta de destinatário
 * (host sem usuário, e-mail da gestão sem usuário, env vazio/mal formado) vira `warn` SEM e-mail, só contagem/índice, e nunca lança.
 */
export class ImportBlockNotifier implements ImportBlockNoticePort {
  constructor(private readonly d: ImportBlockNotifierDeps) {}

  async notify(cli: PoolClient, n: ImportBlockNotice): Promise<void> {
    const base = { kind: this.d.kind, reason: n.reason, meetingAt: n.meetingAt.toISOString(), deadlineAt: n.deadlineAt.toISOString() };
    const hostUid = await this.d.recipients.activeUidByEmail(n.hostEmail, cli);
    if (hostUid) {
      await this.d.publisher.publishAdmissionImportBlocked(cli, { recipientUid: hostUid, payload: { ...base, stage: n.stage, audience: 'host' } });
    } else {
      this.d.log.warn({ audience: 'host', stage: n.stage }, `${this.d.prefix}.import_notice.no_recipient`);
    }
    if (n.warnManagement) await this.notifySupervisors(cli, n, base, hostUid);
  }

  private async notifySupervisors(cli: PoolClient, n: ImportBlockNotice, base: NoticeBase, hostUid: string | null): Promise<void> {
    const { emails, invalid } = (this.d.supervisors ?? supervisorEmails)();
    if (emails.length === 0 || invalid.length > 0) {
      this.d.log.warn({ audience: 'supervisor', configured: emails.length, invalid: invalid.length }, `${this.d.prefix}.import_notice.no_recipient`);
    }
    const hostName = (await this.d.recipients.hostDisplayName(n.hostEmail, cli)) ?? undefined;
    const sent = new Set<string>(hostUid ? [hostUid] : []);
    for (const [index, email] of emails.entries()) {
      const uid = await this.d.recipients.activeUidByEmail(email, cli);
      if (!uid) {
        this.d.log.warn({ audience: 'supervisor', index }, `${this.d.prefix}.import_notice.no_recipient`);
        continue;
      }
      if (sent.has(uid)) continue; // o host já tem a versão dele; a gestão repetida também não recebe duas
      sent.add(uid);
      await this.d.publisher.publishAdmissionImportBlocked(cli, {
        recipientUid: uid,
        payload: { ...base, stage: 'will_be_lost', audience: 'supervisor', hostName },
      });
    }
  }
}
