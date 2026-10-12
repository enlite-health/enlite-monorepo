import type { PoolClient } from 'pg';
import { MEET_LINK_REGEX, extractMeetingCode } from '../infrastructure/GoogleCalendarEventFinder';
import type { AdmissionPostCallRepository, PostCallCandidate } from '../infrastructure/AdmissionPostCallRepository';
import type { AdmissionEventRepository } from '../infrastructure/AdmissionEventRepository';
import { earliestConferenceStart } from '../domain/admissionPostCall';
import type { MeetConferencePort, MeetConferenceRecord } from './ports/MeetConferencePort';
import type { AdmissionLogger } from './AdmissionMessagingService';

export interface AdmissionConferenceObserverDeps {
  repo: Pick<AdmissionPostCallRepository, 'saveSpace' | 'markConferenceStarted'>;
  meet: MeetConferencePort;
  events: Pick<AdmissionEventRepository, 'append'>;
  log: AdmissionLogger;
}

/**
 * AdmissionConferenceObserver — o que o job de 15 min e o de 1 min (spec 050, 4º passo) fazem IGUAL com uma reunião: resolver o
 * espaço do Meet (e guardá-lo), listar as conferências e gravar o INÍCIO real. Extraído do `AdmissionPostCallJob` (F25) sem mudar
 * comportamento, nome de log nem de evento. Roda DENTRO da transação da reunião (o `cli` da trava `FOR UPDATE`). Só ids e contagens.
 */
export class AdmissionConferenceObserver {
  constructor(private readonly deps: AdmissionConferenceObserverDeps) {}

  /**
   * Resolve o espaço, lista as conferências e grava o início. `null` = a reunião não tem link do Meet válido (quem chama bloqueia).
   * Os erros do Meet (`MeetScopeMissingError`, `MeetTransientError`) sobem: quem decide o que fazer com eles é o job.
   */
  async observe(appt: PostCallCandidate, now: Date, cli: PoolClient): Promise<MeetConferenceRecord[] | null> {
    let space = appt.meet_space_name;
    if (!space) {
      const code = meetCodeOf(appt.meet_link);
      if (!code) return null;
      space = (await this.deps.meet.resolveSpace(code, appt.host_email)).spaceName;
      await this.deps.repo.saveSpace(appt.id, space, cli);
    }
    const records = await this.deps.meet.listConferenceRecords(space, appt.host_email);
    await this.recordStart(appt, records, now, cli);
    return records;
  }

  /**
   * F14 (R-7): grava o MENOR `startTime` observado (`conference_started_at`) e, na PRIMEIRA vez, o evento `conference_started` na
   * trilha. O início só anda para trás (conferência mais antiga aparecendo depois). Sem conferência não escreve nada.
   * F25 (R-48): o instante em que o sistema ficou sabendo (`now`, o relógio de quem chama) vai junto, por `COALESCE`.
   */
  async recordStart(appt: PostCallCandidate, records: readonly MeetConferenceRecord[], now: Date, cli: PoolClient): Promise<void> {
    const startedAt = earliestConferenceStart(records);
    if (!startedAt) return;
    const known = appt.conference_started_at ? new Date(appt.conference_started_at).getTime() : null;
    if (known !== null && known <= startedAt.getTime()) return;
    await this.deps.repo.markConferenceStarted(appt.id, startedAt, now, cli);
    if (known !== null) return;
    await this.deps.events.append(
      { appointmentId: appt.id, kind: 'conference_started', outcome: 'started', ref: { parts: records.length, startedAt: startedAt.toISOString() } },
      cli,
    );
    this.deps.log.info({ appointmentId: appt.id, parts: records.length }, 'admission.conference_started');
  }
}

function meetCodeOf(link: string | null): string | null {
  if (!link || !MEET_LINK_REGEX.test(link.trim())) return null;
  return extractMeetingCode(link) || null;
}
