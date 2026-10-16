import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import {
  ADMISSION_POST_CALL_NAMING,
  type Ex,
  type PostCallDetectors,
  type PostCallNaming,
  type PostCallSource,
  type PostCallSubject,
  type SubjectTrail,
} from './ports/PostCallPorts';
import { decidePostCall } from '../domain/admissionPostCall';
import { SKIPPED_TEST_EVENT, admissionRealm, isBlockedFromPaidPath } from '../domain/admissionRealm';
import { MeetScopeMissingError, MeetTransientError, type MeetConferencePort } from './ports/MeetConferencePort';
import type { AdmissionLogger } from './AdmissionMessagingService';
import { AdmissionConferenceObserver } from './AdmissionConferenceObserver';
import { EMPTY_CALENDAR_SWEEP, type AdmissionCalendarSweeps, type CalendarSweepSummary } from './admissionCalendarSweeps';

export interface PostCallSummary extends CalendarSweepSummary {
  candidates: number;
  ended: number;
  noShow: number;
  blocked: number;
  waiting: number;
  transient: number;
  skippedLocked: number;
  /** Reuniões de paciente `is_test` que a fila pulou (R-18): nenhuma chamada ao Meet. */
  skippedTest: number;
  errors: number;
  silenceReminder: number;
  silenceConfirmation: number;
  /** Mensagens `sent` há mais de 24 h sem status final (R-30 b). */
  deliveryNoStatus: number;
}

type Outcome = 'ended' | 'noShow' | 'blocked' | 'waiting' | 'transient' | 'skippedLocked' | 'skippedTest';
type BlockReason = 'meet_scope_missing' | 'no_meet_link';

export interface AdmissionPostCallJobDeps {
  /** FONTE (porto): a admissão passa `AdmissionPostCallRepository`; o enquadre, `EnquadrePostCallRepository`. */
  repo: PostCallSource & Partial<PostCallDetectors>;
  /** Detectores de silêncio/entrega. Padrão: os do próprio `repo`, se os tiver (a admissão); sem eles (enquadre) o job não os roda. */
  detectors?: PostCallDetectors | null;
  meet: MeetConferencePort;
  /** DESTINO (porto): a trilha do sujeito (`admission_events` ou `enquadre_event_trail`). */
  events: SubjectTrail;
  /** Nomes de log; padrão = admissão (`admission.*`, `appointmentId`). */
  naming?: PostCallNaming;
  db?: Pool;
  /** Varreduras do Google (spec 050 F10: R-36 e R-37); sem elas o job roda como antes. */
  calendarSweeps?: Pick<AdmissionCalendarSweeps, 'run'>;
  log?: AdmissionLogger;
  now?: () => Date;
}

function hasDetectors(repo: Partial<PostCallDetectors>): repo is PostCallDetectors {
  return typeof repo.findReminderSilence === 'function' && typeof repo.findConfirmationSilence === 'function' && typeof repo.findStaleSentMessages === 'function';
}

const emptySummary = (): PostCallSummary => ({
  candidates: 0, ended: 0, noShow: 0, blocked: 0, waiting: 0, transient: 0, skippedLocked: 0, skippedTest: 0, errors: 0,
  silenceReminder: 0, silenceConfirmation: 0, deliveryNoStatus: 0,
  ...EMPTY_CALENDAR_SWEEP,
});

/**
 * AdmissionPostCallJob — o job de 15 min, parte 1 (spec 049 F5, §3.3 e §5.3). Roda em `POST /api/internal/jobs/admission-post-call`.
 *
 *  1. Início REAL (F14, R-7): desde a hora marcada, o MENOR `startTime` vai para `conference_started_at` (+ evento `conference_started` 1×).
 *     Fim REAL da call, pelo Google (Meet REST API) e não pela hora marcada: todas as conferências terminadas →
 *     `conference_ended_at` = o maior `endTime` e `import_status='pending'` (a importação, F6, pega daí);
 *     nenhuma conferência até `slot_start + 1 h` → `no_show` (sem tocar Tactiq nem cofre); alguma aberta → espera, sem escrever nada.
 *  2. Escopo do Meet não delegado (H2 aberto) → `blocked reason=meet_scope_missing` + log de alarme. NUNCA `no_show`.
 *  0. Paciente `is_test` (R-18, spec 050): nenhuma chamada ao Meet; um `skipped_test` na trilha e a reunião sai da fila.
 *  3. Detectores de silêncio (§5.3): lembrete e confirmação que deviam ter saído e não saíram → um log por reunião por execução.
 *
 * Idempotente: terminais (`pending`, `no_show`) saem da fila; `FOR UPDATE SKIP LOCKED` por reunião protege execuções
 * sobrepostas. A mudança de estado e o evento da trilha vão na MESMA transação. Log só com ids, contagens e motivos.
 */
export class AdmissionPostCallJob {
  private readonly db: Pool;
  private readonly log: AdmissionLogger;
  private readonly now: () => Date;
  private readonly observer: AdmissionConferenceObserver;
  private readonly naming: PostCallNaming;
  private readonly detectors: PostCallDetectors | null;

  constructor(private readonly deps: AdmissionPostCallJobDeps) {
    this.naming = deps.naming ?? ADMISSION_POST_CALL_NAMING;
    this.detectors = deps.detectors !== undefined ? deps.detectors : hasDetectors(deps.repo) ? deps.repo : null;
    this.db = deps.db ?? DatabaseConnection.getInstance().getPool();
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
    this.now = deps.now ?? (() => new Date());
    this.observer = new AdmissionConferenceObserver({ repo: deps.repo, meet: deps.meet, events: deps.events, log: this.log, naming: this.naming });
  }

  async runOnce(now: Date = this.now()): Promise<PostCallSummary> {
    const summary = emptySummary();
    const ids = await this.deps.repo.listCandidateIds(now);
    summary.candidates = ids.length;

    for (const id of ids) {
      try {
        summary[await this.processOne(id, now)] += 1;
      } catch {
        // Uma reunião com defeito não pode impedir as outras (nem os detectores). Sem texto do erro: pode ecoar dado.
        summary.errors += 1;
        this.log.error({ [this.naming.idKey]: id }, `${this.naming.prefix}.post_call.step_failed`);
      }
    }

    const silence = await this.runSilenceDetectors(now);
    summary.silenceReminder = silence.reminder;
    summary.silenceConfirmation = silence.confirmation;
    summary.deliveryNoStatus = await this.runDeliveryDetector(now);
    Object.assign(summary, await (this.deps.calendarSweeps?.run(now) ?? EMPTY_CALENDAR_SWEEP));

    this.log.info({ ...summary }, `${this.naming.prefix}.post_call.run_done`);
    return summary;
  }

  private async processOne(id: string, now: Date): Promise<Outcome> {
    return withActorContext(this.db, async (cli) => {
      const appt = await this.deps.repo.lockCandidate(id, now, cli);
      if (!appt) return 'skippedLocked';

      // R-18: a função de domínio decide ANTES de qualquer porta. `test` nunca chama o Meet; a trilha ganha UM `skipped_test`
      // (o `ELIGIBLE` do repositório tira a reunião da fila depois dele). `ensaio` (liberação vigente, F3) segue o caminho pago.
      if (isBlockedFromPaidPath(admissionRealm({ isTest: appt.patient_is_test, rehearsalUntil: appt.rehearsal_until, now }))) {
        await this.deps.events.append(
          { appointmentId: appt.id, kind: SKIPPED_TEST_EVENT, outcome: 'skipped', reason: 'post_call', ref: { realm: 'test' } },
          cli,
        );
        this.log.info({ [this.naming.idKey]: appt.id, realm: 'test' }, `${this.naming.prefix}.post_call.skipped_test`);
        return 'skippedTest';
      }

      try {
        const records = await this.observer.observe(appt, now, cli);
        if (!records) return await this.block(appt, 'no_meet_link', cli);

        // F14: o job passa a olhar desde a hora marcada só para gravar o INÍCIO. O fim e o `no_show` seguem decididos só depois
        // do fim marcado, como antes (a regra de `decidePostCall` não muda): antes disso a reunião apenas espera.
        if (now.getTime() < appt.slot_end.getTime()) return 'waiting';
        const decision = decidePostCall({ now, slotStart: appt.slot_start, records });

        if (decision.kind === 'wait') return 'waiting';

        if (decision.kind === 'no_show') {
          await this.deps.repo.markNoShow(appt.id, cli);
          await this.deps.events.append({ appointmentId: appt.id, kind: 'no_show', outcome: 'no_show', reason: 'no_conference_record' }, cli);
          this.log.warn({ [this.naming.idKey]: appt.id }, `${this.naming.prefix}.no_show`);
          return 'noShow';
        }

        await this.observer.recordEnd(appt, decision, now, cli);
        return 'ended';
      } catch (err) {
        if (err instanceof MeetScopeMissingError) return await this.block(appt, 'meet_scope_missing', cli);
        if (err instanceof MeetTransientError) {
          this.log.warn({ [this.naming.idKey]: appt.id, reason: err.reason }, `${this.naming.prefix}.post_call.meet_transient`);
          return 'transient';
        }
        throw err;
      }
    });
  }

  /** `blocked` com motivo. O evento da trilha entra só na TRANSIÇÃO; o log de alarme sai a cada execução enquanto durar. */
  private async block(appt: PostCallSubject, reason: BlockReason, cli: Ex): Promise<Outcome> {
    if (appt.import_status !== 'blocked') {
      await this.deps.repo.markBlocked(appt.id, cli, reason);
      await this.deps.events.append({ appointmentId: appt.id, kind: 'import_blocked', outcome: 'blocked', reason }, cli);
    }
    this.log.error({ [this.naming.idKey]: appt.id, reason }, `${this.naming.prefix}.import_blocked`);
    return 'blocked';
  }

  private async runSilenceDetectors(now: Date): Promise<{ reminder: number; confirmation: number }> {
    const out = { reminder: 0, confirmation: 0 };
    const detectors = this.detectors;
    if (!detectors) return out; // o enquadre não tem mensagens de lembrete/confirmação
    try {
      for (const appointmentId of await detectors.findReminderSilence(now)) {
        this.log.warn({ appointmentId }, `${this.naming.prefix}.silence.reminder`);
        out.reminder += 1;
      }
      for (const appointmentId of await detectors.findConfirmationSilence(now)) {
        this.log.warn({ appointmentId }, `${this.naming.prefix}.silence.confirmation`);
        out.confirmation += 1;
      }
    } catch {
      this.log.error({}, `${this.naming.prefix}.silence.detector_failed`);
    }
    return out;
  }

  /** R-30 (b): UM log por execução, com a contagem e os ids internos (mensagem e reunião). Zero mensagens → nenhum log. */
  private async runDeliveryDetector(now: Date): Promise<number> {
    const detectors = this.detectors;
    if (!detectors) return 0;
    try {
      const stale = await detectors.findStaleSentMessages(now);
      if (stale.length > 0) {
        this.log.warn(
          { count: stale.length, messageIds: stale.map((m) => m.messageId), appointmentIds: [...new Set(stale.map((m) => m.appointmentId))] },
          `${this.naming.prefix}.delivery.no_status`,
        );
      }
      return stale.length;
    } catch {
      this.log.error({}, `${this.naming.prefix}.delivery.detector_failed`);
      return 0;
    }
  }
}
