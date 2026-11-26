import type { Pool, PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import type { TalentumWebhookHealth } from '@shared/events/TalentumWebhookHealthService';
import { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import type { TalentumWebhookAlarm } from '@modules/inapp-notification/infrastructure/NotificationRepository';
import { TalentumAlarmRecipients, type ITalentumAlarmRecipients } from '../infrastructure/TalentumAlarmRecipients';
import { TalentumAlarmStateRepository, type ITalentumAlarmStateRepository } from '../infrastructure/TalentumAlarmStateRepository';
import type { ITalentumConflictNotifier } from './ProcessTalentumPrescreening';

/** Relembra 1× por dia enquanto o alarme durar (spec 095 §3.5). */
export const TALENTUM_ALARM_REMINDER_MS = 24 * 60 * 60 * 1000;

interface AlarmLogger {
  warn(o: Record<string, unknown>): void;
}

export interface TalentumWebhookAlarmNotifierDeps {
  /** Só o ciclo `events/health` precisa dele (abre a própria transação); o conflito usa o client do processador. */
  pool?: Pool;
  publisher?: Pick<SystemNotificationPublisher, 'publishTalentumWebhookAlarm'>;
  recipients?: ITalentumAlarmRecipients;
  state?: ITalentumAlarmStateRepository;
  /** Transação do ciclo (padrão: `withActorContext(pool)`); injetável nos testes. */
  runInTx?: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;
  log?: AlarmLogger;
}

/**
 * Sino do webhook do Talentum (spec 095 §3.5 e §13.4), só no sino, para a coordenação de Recrutamento + Master. Dois usos:
 *  - `notifyCycle` (ciclo `events/health`): dedup por alarme em `talentum_webhook_alarm_state` — avisa na transição fechado→aberto,
 *    relembra a cada 24 h enquanto aberto, não avisa nos ciclos entre os dois, e ZERA a linha quando a contagem volta a 0;
 *  - `notify` (port `ITalentumConflictNotifier`): `CONFLITO_HUMANO`, um aviso por evento, SEM dedup.
 * Falha ao publicar vira `logger.warn({ msg: 'talentum_webhook_alarm', alarme: 'sino_falhou' })` e NUNCA derruba o health nem o
 * processamento da linha da inbox. Sem PII: só enum, inteiro e data.
 */
export class TalentumWebhookAlarmNotifier implements ITalentumConflictNotifier {
  private publisherMemo?: Pick<SystemNotificationPublisher, 'publishTalentumWebhookAlarm'>;
  private readonly recipients: ITalentumAlarmRecipients;
  private readonly state: ITalentumAlarmStateRepository;
  private readonly log: AlarmLogger;
  private readonly runInTx: <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;

  constructor(d: TalentumWebhookAlarmNotifierDeps = {}) {
    this.publisherMemo = d.publisher;
    this.recipients = d.recipients ?? new TalentumAlarmRecipients();
    this.state = d.state ?? new TalentumAlarmStateRepository();
    this.log = d.log ?? logger;
    const pool = d.pool;
    this.runInTx = d.runInTx ?? (<T>(fn: (c: PoolClient) => Promise<T>) => {
      if (!pool) throw new Error('TalentumWebhookAlarmNotifier: sem pool para o ciclo');
      return withActorContext(pool, fn);
    });
  }

  /** Preguiçoso: o default abre `DatabaseConnection` e quem só constrói o processador (testes) não deve pagar isso. */
  private get publisher(): Pick<SystemNotificationPublisher, 'publishTalentumWebhookAlarm'> {
    this.publisherMemo ??= new SystemNotificationPublisher();
    return this.publisherMemo;
  }

  /** Um alarme por transação: estado + aviso andam juntos (se o aviso falha, a linha de estado volta e o próximo ciclo tenta de novo). */
  async notifyCycle(health: TalentumWebhookHealth, now: Date): Promise<void> {
    for (const [alarme, quantidade] of Object.entries(health) as Array<[string, number]>) {
      try {
        await this.runInTx((c) => this.cycleOne(c, alarme, quantidade, now));
      } catch {
        // Nunca a mensagem do erro (o pg pode ecoar dado): só o alarme e a contagem.
        this.log.warn({ msg: 'talentum_webhook_alarm', alarme: 'sino_falhou', origem: alarme, quantidade });
      }
    }
  }

  private async cycleOne(c: PoolClient, alarme: string, quantidade: number, now: Date): Promise<void> {
    const current = await this.state.lock(c, alarme);
    if (quantidade <= 0) {
      if (current) await this.state.close(c, alarme);
      return;
    }
    if (!current) {
      if (!(await this.state.open(c, alarme, now, quantidade))) return; // outro ciclo abriu e avisa
      await this.publish(c, alarme, quantidade, now);
      return;
    }
    const due = current.ultimoAvisoEm === null || current.ultimoAvisoEm.getTime() <= now.getTime() - TALENTUM_ALARM_REMINDER_MS;
    if (due) await this.publish(c, alarme, quantidade, current.abertoDesde);
    await this.state.touch(c, alarme, quantidade, due ? now : null);
  }

  /** `CONFLITO_HUMANO`: SAVEPOINT próprio — a falha do sino desfaz SÓ o sino e não aborta a transação de quem chamou. */
  async notify(client: PoolClient, conflict: { workerId: string; jobPostingId: string; talentumPrescreeningId: string }): Promise<void> {
    this.log.warn({ msg: 'talentum_conflito_humano', ...conflict });
    await client.query('SAVEPOINT talentum_conflito_sino');
    try {
      await this.publish(client, 'CONFLITO_HUMANO', 1, new Date());
      await client.query('RELEASE SAVEPOINT talentum_conflito_sino');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT talentum_conflito_sino');
      this.log.warn({ msg: 'talentum_webhook_alarm', alarme: 'sino_falhou', origem: 'CONFLITO_HUMANO', quantidade: 1 });
    }
  }

  private async publish(c: PoolClient, alarme: TalentumWebhookAlarm | string, quantidade: number, desde: Date): Promise<void> {
    const { uids, withCell } = await this.recipients.resolve(c);
    if (withCell === 0) this.log.warn({ msg: 'talentum_webhook_alarm', alarme: 'sem_coordenacao', origem: alarme });
    if (uids.length === 0) throw new Error('talentum_webhook_alarm: sem destinatário');
    await this.publisher.publishTalentumWebhookAlarm(c, { recipientUids: uids, payload: { alarme, quantidade, desde: desde.toISOString() } });
  }
}
