/**
 * CoordinationAlertUseCase — o alerta à coordenação de presença (emenda 077 §5, D806.5 + D812). Cloud Scheduler a cada 15 min.
 *
 * Duas regras, uma idempotência no banco (`coordination_alert`, UNIQUE (kind, occurrence_id)):
 *   · `PRESENCE_OPEN_4H`: presença `OPEN` e `now ≥ fim previsto + PRESENCE_OPEN_ALERT_AFTER_MIN` (240). O fim vem de `occurrenceWindowOf`,
 *     a MESMA função do itinerário.
 *   · `CHECK_IN_REFUSED_NO_ENTRY`: tentativa de check-in recusada, nenhum check-in aceito e `now ≥ 1ª recusa + REFUSED_CHECKIN_ALERT_AFTER_MIN` (60).
 *     Ocorrência que também está `OPEN` (check-in aceito depois da recusa) NÃO alerta. Ocorrência fora do itinerário não alerta (vai para a fila).
 *   Ambas descartam `is_test` (worker ou paciente, D664).
 *
 * Entrega: in-app NA transação que grava o alerta (se ela cai, o alerta não existe e a próxima execução refaz); e-mail DEPOIS do commit, com
 * reivindicação `SENDING` (molde `UncoveredShiftsAlertUseCase`). Falha de e-mail nunca desfaz a in-app. Zero destinatários = falha contada +
 * `reportError` + `failures > 0` (alarme), e o alerta NÃO é gravado (a próxima execução tenta de novo quando alguém tiver a célula).
 * Attendance fora do ar = a exceção sobe (500; o Scheduler re-tenta). Log SÓ códigos e contagens: nunca uid, e-mail, nome, ids de turno.
 */
import { reportError } from '@shared/logging';
import { operationDateOf } from '@shared/locale/operationDate';
import type {
  AlertRecipient, AlertRecipientResolver, AlertToDeliver, AttendancePresenceAlertReader, CoordinationAlertChannel, CoordinationAlertKind,
  CoordinationAlertStore, ShiftDirectory, ShiftFacts,
} from './ports/CoordinationAlertPorts';
import { coordinationAlertConfigFromEnv, type CoordinationAlertConfig } from './coordinationAlertConfig';

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;
/** O país do Scheduler: a data civil da janela de busca (mesmo critério do "Sin cubrir"). */
const SCHEDULER_COUNTRY = 'AR';

export interface CoordinationAlertResult {
  /** Alertas gravados nesta execução (turnos novos). */
  alerted: number;
  alertedPresenceOpen: number;
  alertedRefusedNoEntry: number;
  /** Turnos que já tinham o alerta (UNIQUE): nada novo. */
  alreadyAlerted: number;
  /** Candidatos sem ocorrência no itinerário: não geram alerta (vão para a fila). */
  unresolved: number;
  skippedTest: number;
  inAppDelivered: number;
  emailsSent: number;
  /** `SKIPPED_TEST`/`SKIPPED_NO_KEY`/`NO_ADDRESS`: canal indisponível, não é falha. */
  emailsSkipped: number;
  emailsFailed: number;
  failures: number;
}

interface Candidate {
  kind: CoordinationAlertKind;
  shift: ShiftFacts;
}

const dateOf = (d: Date): string => operationDateOf(SCHEDULER_COUNTRY, d);

export class CoordinationAlertUseCase {
  constructor(
    private readonly attendance: AttendancePresenceAlertReader,
    private readonly directory: ShiftDirectory,
    private readonly recipients: AlertRecipientResolver,
    private readonly store: CoordinationAlertStore,
    private readonly inApp: CoordinationAlertChannel,
    private readonly email: CoordinationAlertChannel,
    private readonly config: CoordinationAlertConfig = coordinationAlertConfigFromEnv(),
  ) {}

  async execute(input: { now: Date }): Promise<CoordinationAlertResult> {
    const { now } = input;
    const result: CoordinationAlertResult = {
      alerted: 0, alertedPresenceOpen: 0, alertedRefusedNoEntry: 0, alreadyAlerted: 0, unresolved: 0, skippedTest: 0,
      inAppDelivered: 0, emailsSent: 0, emailsSkipped: 0, emailsFailed: 0, failures: 0,
    };

    const lookbackStart = new Date(now.getTime() - this.config.lookbackDays * DAY_MS);
    const open = await this.attendance.openPresence(dateOf(lookbackStart));
    const refused = await this.attendance.refusedWithoutEntry(lookbackStart);
    if (open.length === 0 && refused.length === 0) return result;

    const candidates = new Map<string, { occurrenceId: string; workerId: string }>();
    for (const o of [...open, ...refused]) candidates.set(o.occurrenceId, { occurrenceId: o.occurrenceId, workerId: o.workerId });
    const shifts = await this.directory.resolve([...candidates.values()], {
      from: dateOf(new Date(lookbackStart.getTime() - DAY_MS)),
      to: dateOf(new Date(now.getTime() + DAY_MS)),
    });

    const due: Candidate[] = [];
    const acceptedEntry = new Set(open.map((o) => o.occurrenceId));
    const consider = (kind: CoordinationAlertKind, occurrenceId: string, isDue: (s: ShiftFacts) => boolean): void => {
      const shift = shifts.get(occurrenceId);
      if (!shift) { result.unresolved++; return; }
      if (shift.isTest) { result.skippedTest++; return; }
      if (isDue(shift)) due.push({ kind, shift });
    };
    for (const o of open) {
      consider('PRESENCE_OPEN_4H', o.occurrenceId, (s) => now.getTime() >= Date.parse(s.endsAt) + this.config.presenceOpenAfterMin * MIN_MS);
    }
    for (const r of refused) {
      if (acceptedEntry.has(r.occurrenceId)) continue; // check-in aceito depois da recusa: a entrada aconteceu
      consider('CHECK_IN_REFUSED_NO_ENTRY', r.occurrenceId, () => now.getTime() >= Date.parse(r.firstRefusedAt) + this.config.refusedCheckInAfterMin * MIN_MS);
    }
    if (due.length === 0) return result;

    const everyone = await this.recipients.resolve();
    for (const c of due) await this.alertOne(c, everyone, result);
    return result;
  }

  private async alertOne(c: Candidate, everyone: readonly AlertRecipient[], result: CoordinationAlertResult): Promise<void> {
    const recipients = everyone.filter((r) => r.countries.includes(c.shift.country));
    if (recipients.length === 0) {
      result.failures++;
      reportError(new Error('coordination_alert: zero destinatarios'), { source: 'CoordinationAlertUseCase:recipients', kind: c.kind, country: c.shift.country });
      return;
    }

    let alertId: string | null;
    try {
      alertId = await this.store.inTransaction(async (tx) => {
        const id = await tx.insertAlertIfAbsent(c.kind, c.shift.occurrenceId);
        if (id === null) return null;
        const alert: AlertToDeliver = { alertId: id, kind: c.kind, shift: c.shift };
        for (const recipient of recipients) {
          const delivered = await this.inApp.deliver(alert, recipient, tx.handle);
          await tx.recordDelivery({ alertId: id, recipientUid: recipient.uid, channel: 'IN_APP', status: delivered.status, notificationEventId: delivered.notificationEventId });
          await tx.recordDelivery({ alertId: id, recipientUid: recipient.uid, channel: 'EMAIL', status: 'PENDING' });
        }
        return id;
      });
    } catch (err) {
      result.failures++;
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'CoordinationAlertUseCase:alert', kind: c.kind });
      return;
    }
    if (alertId === null) {
      result.alreadyAlerted++;
      return;
    }
    result.alerted++;
    if (c.kind === 'PRESENCE_OPEN_4H') result.alertedPresenceOpen++;
    else result.alertedRefusedNoEntry++;
    result.inAppDelivered += recipients.length;

    const alert: AlertToDeliver = { alertId, kind: c.kind, shift: c.shift };
    for (const recipient of recipients) await this.sendEmail(alert, recipient, result);
  }

  /** Depois do commit: reivindica a entrega (`SENDING`), envia e grava o resultado. Nada aqui desfaz a in-app. */
  private async sendEmail(alert: AlertToDeliver, recipient: AlertRecipient, result: CoordinationAlertResult): Promise<void> {
    try {
      if (!(await this.store.claimDelivery(alert.alertId, recipient.uid, 'EMAIL'))) return; // outra execução reivindicou: ela envia
      const outcome = await this.email.deliver(alert, recipient);
      if (outcome.status === 'SENT') result.emailsSent++;
      else if (outcome.status === 'FAILED') result.emailsFailed++;
      else result.emailsSkipped++;
      await this.store.markDelivery(alert.alertId, recipient.uid, 'EMAIL', outcome);
    } catch (err) {
      result.failures++;
      reportError(err instanceof Error ? err : new Error(String(err)), { source: 'CoordinationAlertUseCase:email', kind: alert.kind });
    }
  }
}
