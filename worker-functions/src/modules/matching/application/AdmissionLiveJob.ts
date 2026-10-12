import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import type { AdmissionLiveRepository, LiveCandidate } from '../infrastructure/AdmissionLiveRepository';
import type { AdmissionPostCallRepository } from '../infrastructure/AdmissionPostCallRepository';
import type { AdmissionEventRepository } from '../infrastructure/AdmissionEventRepository';
import { decideLive, type LiveEffect } from '../domain/admissionLive';
import { admissionRealm, isBlockedFromPaidPath } from '../domain/admissionRealm';
import { MeetScopeMissingError, MeetTransientError, type MeetConferencePort, type MeetConferenceRecord } from './ports/MeetConferencePort';
import type { AdmissionLogger } from './AdmissionMessagingService';
import { AdmissionConferenceObserver } from './AdmissionConferenceObserver';

/** Só contagens: o que sai no log `admission.live.run_done` e na resposta da rota. */
export interface LiveSummary {
  candidates: number;
  /** Efeitos aplicados (uma reunião pode somar em mais de um). */
  started: number;
  ended: number;
  endedEarly: number;
  reopened: number;
  reopenedAfterSummary: number;
  /** Reuniões em que a rodada gravou algo (a soma dos efeitos está nos campos acima). */
  applied: number;
  /** Reuniões sem nada a gravar nesta rodada. */
  waiting: number;
  skippedLocked: number;
  /** R-18: paciente `is_test` sem liberação vigente. Nenhuma chamada ao Meet; o `skipped_test` é da rede de 15 min. */
  skippedTest: number;
  /** Reabertura que não mexeu porque a importação da reunião estava em voo (volta na rodada seguinte). */
  skippedImporting: number;
  /** Escopo do Meet ausente: só conta. O estado `blocked` e o alarme são da rede de 15 min. */
  scopeMissing: number;
  transient: number;
  noMeetLink: number;
  errors: number;
}

type Outcome = 'applied' | 'waiting' | 'skippedLocked' | 'skippedTest' | 'skippedImporting' | 'scopeMissing' | 'transient' | 'noMeetLink';

export interface AdmissionLiveJobDeps {
  live: AdmissionLiveRepository;
  postCall: Pick<AdmissionPostCallRepository, 'saveSpace' | 'markConferenceStarted' | 'markConferenceEnded' | 'markConferenceEndedEarly'>;
  meet: MeetConferencePort;
  events: AdmissionEventRepository;
  db?: Pool;
  log?: AdmissionLogger;
  now?: () => Date;
}

const emptySummary = (): LiveSummary => ({
  candidates: 0, started: 0, ended: 0, endedEarly: 0, reopened: 0, reopenedAfterSummary: 0, applied: 0, waiting: 0, skippedLocked: 0,
  skippedTest: 0, skippedImporting: 0, scopeMissing: 0, transient: 0, noMeetLink: 0, errors: 0,
});

/**
 * AdmissionLiveJob — o job de 1 minuto (spec 050, 4º passo; R-44 a R-50, R-55, R-56). Roda em `POST /api/internal/jobs/admission-live`.
 * Só olha a janela ativa (`AdmissionLiveRepository`) e NÃO tem regra de negócio própria: `decideLive` decide, ele aplica os efeitos.
 *
 * Por reunião, UMA transação sob a trava de linha (`FOR UPDATE OF a SKIP LOCKED`, a mesma do job de 15 min): `admissionRealm` ANTES
 * de qualquer porta (`test` não chama o Meet nem grava evento) → conferências (`AdmissionConferenceObserver`) → `decideLive` → efeitos
 * e eventos da trilha na MESMA transação. Escopo do Meet ausente e erro transitório só contam: estado e alarme são da rede.
 * Esta fase ARMA o gatilho do resumo e não lê o Tactiq nem importa (gancho da F28). Idempotente: o estado decide, não o relógio.
 * Log só com contagens e ids; nunca nome, e-mail, telefone, link nem texto.
 */
export class AdmissionLiveJob {
  private readonly db: Pool;
  private readonly log: AdmissionLogger;
  private readonly now: () => Date;
  private readonly observer: AdmissionConferenceObserver;

  constructor(private readonly deps: AdmissionLiveJobDeps) {
    this.db = deps.db ?? DatabaseConnection.getInstance().getPool();
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
    this.now = deps.now ?? (() => new Date());
    this.observer = new AdmissionConferenceObserver({ repo: deps.postCall, meet: deps.meet, events: deps.events, log: this.log });
  }

  async runOnce(now: Date = this.now()): Promise<LiveSummary> {
    const summary = emptySummary();
    const ids = await this.deps.live.listActiveIds(now);
    summary.candidates = ids.length;
    for (const id of ids) {
      try {
        summary[await this.processOne(id, now, summary)] += 1;
      } catch {
        // Uma reunião com defeito não impede as outras. Sem texto do erro: pode ecoar dado.
        summary.errors += 1;
        this.log.error({ appointmentId: id }, 'admission.live.step_failed');
      }
    }
    this.log.info({ ...summary }, 'admission.live.run_done');
    return summary;
  }

  private processOne(id: string, now: Date, summary: LiveSummary): Promise<Outcome> {
    return withActorContext(this.db, async (cli) => {
      const appt = await this.deps.live.lockActive(id, now, cli);
      if (!appt) return 'skippedLocked';
      if (isBlockedFromPaidPath(admissionRealm({ isTest: appt.patient_is_test, rehearsalUntil: appt.rehearsal_until, now }))) return 'skippedTest';

      let records: MeetConferenceRecord[] | null;
      try {
        records = await this.observer.listRecords(appt, cli);
      } catch (err) {
        if (err instanceof MeetScopeMissingError) return 'scopeMissing';
        if (err instanceof MeetTransientError) return 'transient';
        throw err;
      }
      if (!records) return 'noMeetLink';

      const effects = decideLive(
        {
          slotStart: appt.slot_start,
          conferenceStartedAt: appt.conference_started_at ? new Date(appt.conference_started_at) : null,
          conferenceEndedAt: appt.conference_ended_at ? new Date(appt.conference_ended_at) : null,
          importStatus: appt.import_status,
          summaryFastState: appt.summary_fast_state,
          reopenAfterSummaryRecorded: appt.reopen_after_summary_recorded,
        },
        records,
      );
      if (effects.length === 0) return 'waiting';

      for (const effect of effects) {
        if (effect.kind === 'reopen_and_cancel' && (await this.deps.live.importInFlight(appt.id, cli))) return 'skippedImporting';
        await this.apply(effect, appt, records, now, cli, summary);
      }
      return 'applied';
    });
  }

  private async apply(effect: LiveEffect, appt: LiveCandidate, records: readonly MeetConferenceRecord[], now: Date, cli: PoolClient, summary: LiveSummary): Promise<void> {
    const names = records.map((r) => r.name);
    switch (effect.kind) {
      case 'record_start':
        await this.observer.recordStart(appt, records, now, cli);
        summary.started += 1;
        return;
      case 'record_end_and_arm':
        await this.observer.recordEnd(appt, { endedAt: effect.endedAt, recordNames: names }, now, cli);
        await this.deps.live.armSummaryTrigger(appt.id, cli);
        summary.ended += 1;
        return;
      case 'record_end_no_arm':
        await this.observer.recordEnd(appt, { endedAt: effect.endedAt, recordNames: names }, now, cli, true);
        summary.endedEarly += 1;
        return;
      case 'reopen_and_cancel':
        await this.deps.live.reopenConference(appt.id, effect.cancelTrigger, cli);
        await this.deps.events.append(
          { appointmentId: appt.id, kind: 'conference_reopened', outcome: 'reopened', reason: 'before_summary', ref: { parts: records.length, triggerCancelled: effect.cancelTrigger } },
          cli,
        );
        this.log.info({ appointmentId: appt.id, reason: 'before_summary' }, 'admission.conference_reopened');
        summary.reopened += 1;
        return;
      case 'reopen_after_summary':
        await this.deps.events.append(
          { appointmentId: appt.id, kind: 'conference_reopened', outcome: 'reopened', reason: 'after_summary', ref: { parts: records.length } },
          cli,
        );
        this.log.info({ appointmentId: appt.id, reason: 'after_summary' }, 'admission.conference_reopened');
        summary.reopenedAfterSummary += 1;
        return;
    }
  }
}
