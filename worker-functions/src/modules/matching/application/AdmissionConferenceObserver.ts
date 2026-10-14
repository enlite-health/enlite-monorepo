import type { PoolClient } from 'pg';
import { MEET_LINK_REGEX, extractMeetingCode } from '../infrastructure/GoogleCalendarEventFinder';
import { ADMISSION_POST_CALL_NAMING, type PostCallNaming, type PostCallSource, type PostCallSubject, type SubjectTrail } from './ports/PostCallPorts';
import { earliestConferenceStart } from '../domain/admissionPostCall';
import type { MeetConferencePort, MeetConferenceRecord } from './ports/MeetConferencePort';
import type { AdmissionLogger } from './AdmissionMessagingService';

export interface AdmissionConferenceObserverDeps {
  repo: Pick<PostCallSource, 'saveSpace' | 'markConferenceStarted' | 'markConferenceEnded' | 'markConferenceEndedEarly'>;
  meet: MeetConferencePort;
  events: SubjectTrail;
  /** Nomes de log (padrão: admissão). */
  naming?: PostCallNaming;
  log: AdmissionLogger;
}

/**
 * AdmissionConferenceObserver — o que o job de 15 min e o de 1 min (spec 050, 4º passo) fazem IGUAL com uma reunião: resolver o
 * espaço do Meet (e guardá-lo), listar as conferências e gravar o INÍCIO real. Extraído do `AdmissionPostCallJob` (F25) sem mudar
 * comportamento, nome de log nem de evento. Roda DENTRO da transação da reunião (o `cli` da trava `FOR UPDATE`). Só ids e contagens.
 */
export class AdmissionConferenceObserver {
  private readonly naming: PostCallNaming;

  constructor(private readonly deps: AdmissionConferenceObserverDeps) {
    this.naming = deps.naming ?? ADMISSION_POST_CALL_NAMING;
  }

  /**
   * Resolve o espaço, lista as conferências e grava o início. `null` = a reunião não tem link do Meet válido (quem chama bloqueia).
   * Os erros do Meet (`MeetScopeMissingError`, `MeetTransientError`) sobem: quem decide o que fazer com eles é o job.
   */
  async observe(appt: PostCallSubject, now: Date, cli: PoolClient): Promise<MeetConferenceRecord[] | null> {
    const records = await this.listRecords(appt, cli);
    if (records) await this.recordStart(appt, records, now, cli);
    return records;
  }

  /** Resolve o espaço (guardando-o) e lista as conferências, SEM gravar o início (o job de 1 min grava o que `decideLive` mandar). */
  async listRecords(appt: PostCallSubject, cli: PoolClient): Promise<MeetConferenceRecord[] | null> {
    let space = appt.meet_space_name;
    if (!space) {
      const code = meetCodeOf(appt.meet_link);
      if (!code) return null;
      space = (await this.deps.meet.resolveSpace(code, appt.host_email)).spaceName;
      await this.deps.repo.saveSpace(appt.id, space, cli);
    }
    return this.deps.meet.listConferenceRecords(space, appt.host_email);
  }

  /**
   * Grava o FIM real e o evento `conference_ended` (a rede de 15 min e o job de 1 min, pelo mesmo caminho). `early` (R-56, só o job de
   * 1 min): fim cedo demais — grava sem `pending` e com `reason='too_early'`. Fora disso `pending` e, se a reunião estava `blocked`,
   * `reason='unblocked'`. "Ficou sabendo" do fim = `now`, regravado a cada fim novo.
   */
  async recordEnd(
    appt: Pick<PostCallSubject, 'id' | 'import_status'>,
    end: { endedAt: Date; recordNames: readonly string[] },
    now: Date,
    cli: PoolClient,
    early = false,
  ): Promise<void> {
    if (early) await this.deps.repo.markConferenceEndedEarly(appt.id, end.endedAt, now, cli);
    else await this.deps.repo.markConferenceEnded(appt.id, end.endedAt, now, cli);
    await this.deps.events.append(
      {
        appointmentId: appt.id,
        kind: 'conference_ended',
        outcome: 'ended',
        reason: early ? 'too_early' : appt.import_status === 'blocked' ? 'unblocked' : null,
        ref: { parts: end.recordNames.length, conferenceRecords: end.recordNames.join(','), endedAt: end.endedAt.toISOString() },
      },
      cli,
    );
    this.deps.log.info({ [this.naming.idKey]: appt.id, parts: end.recordNames.length }, `${this.naming.prefix}.conference_ended`);
  }

  /**
   * F14 (R-7): grava o MENOR `startTime` observado (`conference_started_at`) e, na PRIMEIRA vez, o evento `conference_started` na
   * trilha. O início só anda para trás (conferência mais antiga aparecendo depois). Sem conferência não escreve nada.
   * F25 (R-48): o instante em que o sistema ficou sabendo (`now`, o relógio de quem chama) vai junto, por `COALESCE`.
   */
  async recordStart(appt: PostCallSubject, records: readonly MeetConferenceRecord[], now: Date, cli: PoolClient): Promise<void> {
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
    this.deps.log.info({ [this.naming.idKey]: appt.id, parts: records.length }, `${this.naming.prefix}.conference_started`);
  }
}

function meetCodeOf(link: string | null): string | null {
  if (!link || !MEET_LINK_REGEX.test(link.trim())) return null;
  return extractMeetingCode(link) || null;
}
