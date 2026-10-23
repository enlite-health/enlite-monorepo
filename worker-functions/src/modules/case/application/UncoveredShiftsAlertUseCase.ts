/**
 * UncoveredShiftsAlertUseCase — o alerta diário "Sin cubrir" (spec 069 F4, FR-35, P9/P10/P13/P14).
 *
 *   1. por país (data de operação do PRÓPRIO país): lê o universo e aplica `uncoveredDayAlerts` — a ÚNICA regra de "quem conta"
 *      (montado + fora de estado manual travado; janela `[hoje, hoje+6]`) — e agrega turnos por (paciente, serviço);
 *   2. resolve os destinatários (célula `patient_itinerary:update` ∪ Acesso Master) e seus países;
 *   3. por destinatário com ≥ 1 turno: UMA transação grava evento + notificação in-app + despacho `PENDING`. A PK do despacho
 *      `(dia, destinatário)` é a idempotência: a 2ª chamada do dia viola a PK e a transação volta (nada novo, `alreadySent`);
 *   4. DEPOIS do commit, tenta o e-mail dos despachos retomáveis (`PENDING`/`FAILED`, dos últimos `RETRY_WINDOW_DAYS` dias) e grava o
 *      resultado em `email_status`. Cada linha é REIVINDICADA (`claimEmail` → `SENDING`) antes do envio: duas execuções concorrentes
 *      não mandam o e-mail em duplicidade. O payload é montado com a cobertura de AGORA (este `execute` acabou de recalculá-la): destinatário
 *      sem turno descoberto hoje não recebe e-mail de dia anterior. Falha de e-mail nunca desfaz a in-app. ⚑ Falha da in-app (banco)
 *      não envia e-mail naquela chamada: o e-mail precisa da linha de despacho para registrar o resultado; o retry do Scheduler e o
 *      alarme `itinerary_daily_run_failures` (rotina terminada com `failures > 0`) cobrem.
 *   Sem turno descoberto = nada é gravado nem enviado. O e-mail passa por `EmailService.assertCanSend` (teste NUNCA toca canal real).
 * Isolamento: erro num país ou num destinatário é contado em `failures` e `reportError`; os demais seguem. Log SEM PII (contagens).
 *
 * `operationDate` do despacho = data de operação do país do Scheduler (AR, P11): é a chave do dia do destinatário, que pode ver mais de
 * um país. A janela de cada país usa a data do PRÓPRIO país.
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { reportError } from '@shared/logging';
import { operationDateOf } from '@shared/locale/operationDate';
import { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { EmailChannelUnavailableError, EmailService } from '@modules/identity/infrastructure/EmailService';
import { uncoveredDayAlerts, uncoveredShiftCount } from '../domain/itineraryAlerts';
import { expandServiceOccurrences, uncoveredWindow, UNCOVERED_HORIZON_DAYS } from '../domain/serviceOccurrences';
import { UncoveredAlertReader } from '../infrastructure/UncoveredAlertReader';
import { UncoveredAlertRecipients, type AlertRecipient } from '../infrastructure/UncoveredAlertRecipients';
import { UncoveredAlertDispatchRepository, isAlreadyDispatched, type AlertEmailStatus, type RetryableDispatch } from '../infrastructure/UncoveredAlertDispatchRepository';

/** O país do Scheduler (P11): dá a data de operação do despacho do dia. */
export const ALERT_DISPATCH_COUNTRY = 'AR';

export interface UncoveredAlertItem {
  country: string;
  patientId: string;
  patientName: string;
  serviceId: string;
  serviceCode: string;
  shifts: number;
  firstDate: string;
}

export interface UncoveredAlertResult {
  operationDate: string;
  /** Destinatários com ≥ 1 turno no seu escopo de país. */
  alertRecipients: number;
  /** Avisos in-app criados nesta chamada. */
  notified: number;
  /** Destinatários que já tinham despacho do dia (PK): nada novo. */
  alreadySent: number;
  emailsSent: number;
  /** `SKIPPED_TEST`/`SKIPPED_NO_KEY`/`NO_ADDRESS`: canal indisponível, não é falha. */
  emailsSkipped: number;
  emailsFailed: number;
  skippedNoCountry: number;
  failures: number;
}

/** Falha isolada: conta em `failures` e reporta (erro não-Error é embrulhado). Nunca leva PII — só a fonte e, quando há, o país. */
function recordFailure(result: UncoveredAlertResult, err: unknown, context: { source: string; country?: string }): void {
  result.failures++;
  reportError(err instanceof Error ? err : new Error(String(err)), context);
}

const FALLBACK_NAME = 'Paciente sin nombre';

/** Código de erro sem PII: só `code`/`name` do erro, nunca a mensagem (o SendGrid pode ecoar o endereço). */
function errorCodeOf(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown };
  return String(typeof e.code === 'string' || typeof e.code === 'number' ? e.code : e.name ?? 'EMAIL_ERROR').slice(0, 64);
}

export class UncoveredShiftsAlertUseCase {
  private poolMemo?: Pool;

  constructor(
    private readonly reader: UncoveredAlertReader = new UncoveredAlertReader(),
    private readonly recipients: UncoveredAlertRecipients = new UncoveredAlertRecipients(),
    private readonly dispatches: UncoveredAlertDispatchRepository = new UncoveredAlertDispatchRepository(),
    private readonly publisher: SystemNotificationPublisher = new SystemNotificationPublisher(),
    private readonly email: Pick<EmailService, 'sendItineraryUncoveredShiftsDigest'> = new EmailService(),
  ) {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async execute(input: { now: Date; countries: readonly string[] }): Promise<UncoveredAlertResult> {
    const operationDate = operationDateOf(ALERT_DISPATCH_COUNTRY, input.now);
    const result: UncoveredAlertResult = {
      operationDate, alertRecipients: 0, notified: 0, alreadySent: 0, emailsSent: 0, emailsSkipped: 0, emailsFailed: 0, skippedNoCountry: 0, failures: 0,
    };

    const itemsByCountry = new Map<string, UncoveredAlertItem[]>();
    for (const country of input.countries) {
      try {
        const items = await withActorContext(this.pool, (client) => this.selectItems(client, country, operationDateOf(country, input.now)));
        itemsByCountry.set(country, items);
      } catch (err) {
        recordFailure(result, err, { source: 'UncoveredShiftsAlertUseCase:select', country });
      }
    }

    let resolved: Awaited<ReturnType<UncoveredAlertRecipients['resolve']>>;
    try {
      resolved = await this.recipients.resolve(this.pool);
    } catch (err) {
      recordFailure(result, err, { source: 'UncoveredShiftsAlertUseCase:recipients' });
      return result;
    }
    result.skippedNoCountry = resolved.skippedNoCountry;

    const mineByUid = new Map<string, { recipient: AlertRecipient; items: UncoveredAlertItem[] }>();
    for (const recipient of resolved.recipients) {
      const items = recipient.countries.flatMap((c) => itemsByCountry.get(c) ?? []);
      if (items.length === 0) continue;
      result.alertRecipients++;
      mineByUid.set(recipient.uid, { recipient, items });
      await this.createNotification(recipient, items, operationDate, result);
    }

    await this.sendPendingEmails(mineByUid, operationDate, result);
    return result;
  }

  /** Aplica a regra do universo (uma só) ao país e agrega os turnos por (paciente, serviço). */
  private async selectItems(client: PoolClient, country: string, asOf: string): Promise<UncoveredAlertItem[]> {
    const { from, to } = uncoveredWindow(asOf);
    const universe = await this.reader.readUniverse(client, country, asOf);
    const counted = new Map<string, { patientId: string; serviceId: string; shifts: number; firstDate: string }>();
    for (const p of universe) {
      const occurrences = expandServiceOccurrences(p.inputs.slots, p.inputs.assignments, p.inputs.absences, from, to);
      const alerts = uncoveredDayAlerts(occurrences, asOf, p.facts);
      for (const serviceId of new Set(alerts.map((a) => a.serviceId))) {
        const mine = alerts.filter((a) => a.serviceId === serviceId);
        counted.set(`${p.patientId}|${serviceId}`, { patientId: p.patientId, serviceId, shifts: uncoveredShiftCount(mine), firstDate: mine[0].date });
      }
    }
    if (counted.size === 0) return [];

    const labels = await this.reader.readLabels(client, [...new Set([...counted.values()].map((c) => c.patientId))]);
    const labelOf = new Map(labels.map((l) => [`${l.patientId}|${l.serviceId}`, l]));
    return [...counted.entries()]
      .map(([key, c]) => ({
        country,
        ...c,
        patientName: labelOf.get(key)?.patientName ?? FALLBACK_NAME,
        serviceCode: labelOf.get(key)?.serviceCode ?? '',
      }))
      .sort((a, b) => a.patientName.localeCompare(b.patientName) || a.serviceCode.localeCompare(b.serviceCode) || a.serviceId.localeCompare(b.serviceId));
  }

  /** Uma transação: evento + notificação + despacho `PENDING`. PK violada = já enviado hoje (a transação inteira volta). */
  private async createNotification(recipient: AlertRecipient, items: UncoveredAlertItem[], operationDate: string, result: UncoveredAlertResult): Promise<void> {
    try {
      await withActorContext(this.pool, async (client) => {
        const eventId = await this.publisher.publishItineraryUncoveredShifts(client, {
          recipientUid: recipient.uid,
          operationDate,
          items: items.map((i) => ({ patientId: i.patientId, serviceId: i.serviceId, shifts: i.shifts, firstDate: i.firstDate })),
        });
        await this.dispatches.insertPending(client, { operationDate, recipientUid: recipient.uid, eventId });
      });
      result.notified++;
    } catch (err) {
      if (isAlreadyDispatched(err)) {
        result.alreadySent++;
        return;
      }
      recordFailure(result, err, { source: 'UncoveredShiftsAlertUseCase:notify' });
    }
  }

  /** Depois do commit: e-mail dos despachos retomáveis (os recém-criados e os de chamadas anteriores, janela de `RETRY_WINDOW_DAYS`). */
  private async sendPendingEmails(
    mineByUid: ReadonlyMap<string, { recipient: AlertRecipient; items: UncoveredAlertItem[] }>,
    operationDate: string,
    result: UncoveredAlertResult,
  ): Promise<void> {
    let retryable: RetryableDispatch[];
    try {
      retryable = await withActorContext(this.pool, (client) => this.dispatches.listRetryable(client, operationDate));
    } catch (err) {
      recordFailure(result, err, { source: 'UncoveredShiftsAlertUseCase:retryable' });
      return;
    }
    for (const dispatch of retryable) {
      const mine = mineByUid.get(dispatch.recipientUid);
      if (!mine) continue; // perdeu a célula ou os turnos foram cobertos desde o despacho: o aviso in-app já existe, nada a reenviar
      const key = { operationDate: dispatch.operationDate, recipientUid: dispatch.recipientUid };
      let claimed: boolean;
      try {
        claimed = await withActorContext(this.pool, (client) => this.dispatches.claimEmail(client, key));
      } catch (err) {
        recordFailure(result, err, { source: 'UncoveredShiftsAlertUseCase:claim' });
        continue;
      }
      if (!claimed) continue; // outra execução reivindicou a linha: ela envia, esta não duplica
      const { status, errorCode } = await this.trySend(mine.recipient, mine.items, operationDate);
      if (status === 'SENT') result.emailsSent++;
      else if (status === 'FAILED') result.emailsFailed++;
      else result.emailsSkipped++;
      try {
        await withActorContext(this.pool, (client) => this.dispatches.markEmail(client, { ...key, status, errorCode }));
      } catch (err) {
        recordFailure(result, err, { source: 'UncoveredShiftsAlertUseCase:markEmail' });
      }
    }
  }

  private async trySend(recipient: AlertRecipient, items: UncoveredAlertItem[], operationDate: string): Promise<{ status: AlertEmailStatus; errorCode: string | null }> {
    if (!recipient.email) return { status: 'NO_ADDRESS', errorCode: null };
    try {
      await this.email.sendItineraryUncoveredShiftsDigest(recipient.email, items, operationDate, UNCOVERED_HORIZON_DAYS);
      return { status: 'SENT', errorCode: null };
    } catch (err) {
      if (err instanceof EmailChannelUnavailableError) {
        return { status: err.motivo === 'ambiente de teste' ? 'SKIPPED_TEST' : 'SKIPPED_NO_KEY', errorCode: null };
      }
      return { status: 'FAILED', errorCode: errorCodeOf(err) };
    }
  }
}
