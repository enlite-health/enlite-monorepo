import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import { MEET_LINK_REGEX, extractMeetingCode } from '../infrastructure/GoogleCalendarEventFinder';
import type { AdmissionPostCallRepository, PostCallCandidate } from '../infrastructure/AdmissionPostCallRepository';
import type { AdmissionEventRepository } from '../infrastructure/AdmissionEventRepository';
import { decidePostCall } from '../domain/admissionPostCall';
import { MeetScopeMissingError, MeetTransientError, type MeetConferencePort } from './ports/MeetConferencePort';
import type { AdmissionLogger } from './AdmissionMessagingService';

export interface PostCallSummary {
  candidates: number;
  ended: number;
  noShow: number;
  blocked: number;
  waiting: number;
  transient: number;
  skippedLocked: number;
  errors: number;
  silenceReminder: number;
  silenceConfirmation: number;
}

type Outcome = 'ended' | 'noShow' | 'blocked' | 'waiting' | 'transient' | 'skippedLocked';
type BlockReason = 'meet_scope_missing' | 'no_meet_link';

export interface AdmissionPostCallJobDeps {
  repo: AdmissionPostCallRepository;
  meet: MeetConferencePort;
  events: AdmissionEventRepository;
  db?: Pool;
  log?: AdmissionLogger;
  now?: () => Date;
}

const emptySummary = (): PostCallSummary => ({
  candidates: 0, ended: 0, noShow: 0, blocked: 0, waiting: 0, transient: 0, skippedLocked: 0, errors: 0,
  silenceReminder: 0, silenceConfirmation: 0,
});

/**
 * AdmissionPostCallJob — o job de 15 min, parte 1 (spec 049 F5, §3.3 e §5.3). Roda em `POST /api/internal/jobs/admission-post-call`.
 *
 *  1. Fim REAL da call, pelo Google (Meet REST API) e não pela hora marcada: todas as conferências terminadas →
 *     `conference_ended_at` = o maior `endTime` e `import_status='pending'` (a importação, F6, pega daí);
 *     nenhuma conferência até `slot_start + 1 h` → `no_show` (sem tocar Tactiq nem cofre); alguma aberta → espera, sem escrever nada.
 *  2. Escopo do Meet não delegado (H2 aberto) → `blocked reason=meet_scope_missing` + log de alarme. NUNCA `no_show`.
 *  3. Detectores de silêncio (§5.3): lembrete e confirmação que deviam ter saído e não saíram → um log por reunião por execução.
 *
 * Idempotente: terminais (`pending`, `no_show`) saem da fila; `FOR UPDATE SKIP LOCKED` por reunião protege execuções
 * sobrepostas. A mudança de estado e o evento da trilha vão na MESMA transação. Log só com ids, contagens e motivos.
 */
export class AdmissionPostCallJob {
  private readonly db: Pool;
  private readonly log: AdmissionLogger;
  private readonly now: () => Date;

  constructor(private readonly deps: AdmissionPostCallJobDeps) {
    this.db = deps.db ?? DatabaseConnection.getInstance().getPool();
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
    this.now = deps.now ?? (() => new Date());
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
        this.log.error({ appointmentId: id }, 'admission.post_call.step_failed');
      }
    }

    const silence = await this.runSilenceDetectors(now);
    summary.silenceReminder = silence.reminder;
    summary.silenceConfirmation = silence.confirmation;

    this.log.info({ ...summary }, 'admission.post_call.run_done');
    return summary;
  }

  private async processOne(id: string, now: Date): Promise<Outcome> {
    return withActorContext(this.db, async (cli) => {
      const appt = await this.deps.repo.lockCandidate(id, now, cli);
      if (!appt) return 'skippedLocked';

      try {
        let space = appt.meet_space_name;
        if (!space) {
          const code = meetCodeOf(appt.meet_link);
          if (!code) return await this.block(appt, 'no_meet_link', cli);
          space = (await this.deps.meet.resolveSpace(code, appt.host_email)).spaceName;
          await this.deps.repo.saveSpace(appt.id, space, cli);
        }
        const records = await this.deps.meet.listConferenceRecords(space, appt.host_email);
        const decision = decidePostCall({ now, slotStart: appt.slot_start, records });

        if (decision.kind === 'wait') return 'waiting';

        if (decision.kind === 'no_show') {
          await this.deps.repo.markNoShow(appt.id, cli);
          await this.deps.events.append({ appointmentId: appt.id, kind: 'no_show', outcome: 'no_show', reason: 'no_conference_record' }, cli);
          this.log.warn({ appointmentId: appt.id }, 'admission.no_show');
          return 'noShow';
        }

        await this.deps.repo.markConferenceEnded(appt.id, decision.endedAt, cli);
        await this.deps.events.append(
          {
            appointmentId: appt.id,
            kind: 'conference_ended',
            outcome: 'ended',
            reason: appt.import_status === 'blocked' ? 'unblocked' : null,
            ref: { parts: decision.recordNames.length, conferenceRecords: decision.recordNames.join(','), endedAt: decision.endedAt.toISOString() },
          },
          cli,
        );
        this.log.info({ appointmentId: appt.id, parts: decision.recordNames.length }, 'admission.conference_ended');
        return 'ended';
      } catch (err) {
        if (err instanceof MeetScopeMissingError) return await this.block(appt, 'meet_scope_missing', cli);
        if (err instanceof MeetTransientError) {
          this.log.warn({ appointmentId: appt.id, reason: err.reason }, 'admission.post_call.meet_transient');
          return 'transient';
        }
        throw err;
      }
    });
  }

  /** `blocked` com motivo. O evento da trilha entra só na TRANSIÇÃO; o log de alarme sai a cada execução enquanto durar. */
  private async block(appt: PostCallCandidate, reason: BlockReason, cli: Parameters<AdmissionPostCallRepository['markBlocked']>[1]): Promise<Outcome> {
    if (appt.import_status !== 'blocked') {
      await this.deps.repo.markBlocked(appt.id, cli);
      await this.deps.events.append({ appointmentId: appt.id, kind: 'import_blocked', outcome: 'blocked', reason }, cli);
    }
    this.log.error({ appointmentId: appt.id, reason }, 'admission.import_blocked');
    return 'blocked';
  }

  private async runSilenceDetectors(now: Date): Promise<{ reminder: number; confirmation: number }> {
    const out = { reminder: 0, confirmation: 0 };
    try {
      for (const appointmentId of await this.deps.repo.findReminderSilence(now)) {
        this.log.warn({ appointmentId }, 'admission.silence.reminder');
        out.reminder += 1;
      }
      for (const appointmentId of await this.deps.repo.findConfirmationSilence(now)) {
        this.log.warn({ appointmentId }, 'admission.silence.confirmation');
        out.confirmation += 1;
      }
    } catch {
      this.log.error({}, 'admission.silence.detector_failed');
    }
    return out;
  }
}

function meetCodeOf(link: string | null): string | null {
  if (!link || !MEET_LINK_REGEX.test(link.trim())) return null;
  return extractMeetingCode(link) || null;
}
