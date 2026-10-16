/**
 * SweepTherapeuticContactRemindersUseCase — varredura diária dos lembretes de contato pendente do PT (spec 048).
 *
 * Chamada pelo Cloud Scheduler (`POST /api/internal/therapeutic-projects/contact-reminders/sweep`, 09:00 AR). Os
 * lembretes são uma OUTBOX gravada na transação da versão; aqui só se consome:
 *
 *   por ciclo vencido, 1 transação: trava o ciclo (SKIP LOCKED) e o paciente -> lê a versão VIGENTE na hora ->
 *     · nada pendente  -> cancela o resto, fecha o ciclo (RESOLVED), NINGUÉM é avisado;
 *     · há pendente    -> UMA notificação por destinatário, listando só o que ainda está pendente; carimba
 *                         `sent_at` na MESMA transação do evento do sino (ou grava ou nenhum dos dois);
 *       os lembretes menores já vencidos viram SUPERSEDED (job parado alguns dias manda UMA, pelo maior dia);
 *       o dia 12 também avisa quem tem `incomplete_alert` e fecha o ciclo (COMPLETED).
 *
 * Idempotente: re-executar encontra `sent_at` preenchido e não faz nada. Erro num ciclo = rollback só dele.
 * Log: só contagens e `cycleId` — nunca uid de destinatário, nome, nº do caso ou campo junto de paciente.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { reportError } from '@shared/logging';
import { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { currentVersionOf } from '../domain/TherapeuticProject';
import { TherapeuticProjectRepository } from '../infrastructure/TherapeuticProjectRepository';
import { TherapeuticProjectContactStatusRepository } from '../infrastructure/TherapeuticProjectContactStatusRepository';
import { TherapeuticContactReminderRepository } from '../infrastructure/TherapeuticContactReminderRepository';
import { TherapeuticContactReminderRecipients } from '../infrastructure/TherapeuticContactReminderRecipients';

export interface SweepResult {
  cycles: number;
  sent: number;
  cancelled: number;
  superseded: number;
  skippedNoRecipient: number;
  failed: number;
  remainingDue: number;
}

type CycleOutcome = Pick<SweepResult, 'sent' | 'cancelled' | 'superseded' | 'skippedNoRecipient'>;
const EMPTY: CycleOutcome = { sent: 0, cancelled: 0, superseded: 0, skippedNoRecipient: 0 };

/** O dia em que o ciclo se completa (último lembrete). */
const LAST_DAY_OFFSET = 12;

export class SweepTherapeuticContactRemindersUseCase {
  private poolMemo?: Pool;

  constructor(
    private readonly reminders: TherapeuticContactReminderRepository = new TherapeuticContactReminderRepository(),
    private readonly projects: TherapeuticProjectRepository = new TherapeuticProjectRepository(),
    private readonly statuses: TherapeuticProjectContactStatusRepository = new TherapeuticProjectContactStatusRepository(),
    private readonly recipients: TherapeuticContactReminderRecipients = new TherapeuticContactReminderRecipients(),
    private readonly publisher: SystemNotificationPublisher = new SystemNotificationPublisher(),
  ) {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async execute(input: { limit: number }): Promise<SweepResult> {
    const total: SweepResult = { cycles: 0, ...EMPTY, failed: 0, remainingDue: 0 };
    const failedCycles: string[] = [];

    while (total.cycles + total.failed < input.limit) {
      let cycleId: string | null = null;
      try {
        const outcome = await withActorContext(this.pool, async (cli) => {
          const cycle = await this.reminders.claimNextDueCycle(cli, failedCycles);
          if (!cycle) return null;
          cycleId = cycle.id;
          await this.reminders.lockPatient(cli, cycle.patientId);
          return this.processCycle(cli, cycle);
        });
        if (!outcome) break;
        total.cycles++;
        total.sent += outcome.sent;
        total.cancelled += outcome.cancelled;
        total.superseded += outcome.superseded;
        total.skippedNoRecipient += outcome.skippedNoRecipient;
      } catch (err) {
        total.failed++;
        if (cycleId) failedCycles.push(cycleId);
        reportError(err instanceof Error ? err : new Error(String(err)), { source: 'SweepTherapeuticContactRemindersUseCase', cycleId });
        // Sem cycleId (falha ao travar/ler): não há como seguir sem laço infinito.
        if (!cycleId) break;
      }
    }
    total.remainingDue = await this.reminders.countDueCycles(this.pool);
    return total;
  }

  private async processCycle(
    cli: Parameters<TherapeuticContactReminderRepository['dueReminders']>[0],
    cycle: { id: string; patientId: string },
  ): Promise<CycleOutcome> {
    const due = await this.reminders.dueReminders(cli, cycle.id);
    const versions = await this.projects.listForPatient(cycle.patientId, cli);
    const vigente = currentVersionOf(versions);

    if (!vigente) {
      const cancelled = await this.reminders.cancelOpenRemindersOfCycle(cli, cycle.id, 'NO_CURRENT_VERSION');
      await this.reminders.closeCycle(cli, cycle.id, 'NO_CURRENT_VERSION');
      return { ...EMPTY, cancelled };
    }

    const statusRows = (await this.statuses.listByVersions([vigente.id], cli)).get(vigente.id) ?? [];
    const pending = statusRows.filter((r) => r.status === 'PENDING');
    if (pending.length === 0) {
      const cancelled = await this.reminders.cancelOpenRemindersOfCycle(cli, cycle.id, 'RESOLVED');
      await this.reminders.closeCycle(cli, cycle.id, 'RESOLVED');
      return { ...EMPTY, cancelled };
    }

    const last = due[due.length - 1];
    const superseded = await this.reminders.cancelReminders(cli, due.slice(0, -1).map((d) => d.id), 'SUPERSEDED');
    const recipients = await this.recipients.resolve(cli, pending, last.dayOffset >= LAST_DAY_OFFSET);
    const eventIds = await this.publisher.publishPtContactsPending(cli, {
      patientId: cycle.patientId,
      cycleId: cycle.id,
      versionId: vigente.id,
      dayOffset: last.dayOffset,
      recipients,
    });
    await this.reminders.markSent(cli, last.id, eventIds[0] ?? null);
    if (last.dayOffset >= LAST_DAY_OFFSET) await this.reminders.closeCycle(cli, cycle.id, 'COMPLETED');
    return { ...EMPTY, sent: eventIds.length > 0 ? 1 : 0, skippedNoRecipient: eventIds.length > 0 ? 0 : 1, superseded };
  }
}
