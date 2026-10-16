import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { logger } from '@shared/logging';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { decidePresence, type PresenceConvocado } from '../domain/enquadrePresence';
import { EnquadrePresenceRepository } from '../infrastructure/EnquadrePresenceRepository';
import { MeetScopeMissingError, MeetTransientError, type MeetConferencePort, type MeetParticipant } from './ports/MeetConferencePort';
import type { AdmissionLogger } from './AdmissionMessagingService';

export interface EnquadrePresenceSummary {
  candidates: number;
  measured: number;
  /** Falha do Meet (ou evento sem espaço): a presença fica NULL e a próxima rodada tenta de novo. */
  failed: number;
}

export interface EnquadrePresenceDeps {
  meet: MeetConferencePort;
  db?: Pool;
  repo?: EnquadrePresenceRepository;
  decryptor?: Pick<KMSEncryptionService, 'decrypt'>;
  log?: AdmissionLogger;
}

/**
 * EnquadrePresenceService — mede quem entrou na call do enquadre (spec 052, Fase 3, T-34c), depois do fim real gravado pelo job de fim
 * de call. Uma rodada: para cada evento da fila, `conferenceRecords.list` + `participants.list` de cada conferência, a ligação por nome
 * único (`decidePresence`) e a gravação de `attendance`/`match_method` por convocado.
 *
 * NUNCA derruba nada: falha do Meet (escopo, rede, 5xx) deixa a presença NULL e loga SÓ o motivo e o id do evento; o job de fim de call
 * e a importação do Tactiq nem ficam sabendo. Log: só `event_id`, tipo do participante, motivo e contagens — nunca nome, e-mail,
 * telefone nem `users/{id}` do Google.
 */
export class EnquadrePresenceService {
  private readonly db: Pool;
  private readonly repo: EnquadrePresenceRepository;
  private readonly log: AdmissionLogger;
  private dec: Pick<KMSEncryptionService, 'decrypt'> | null;

  constructor(private readonly deps: EnquadrePresenceDeps) {
    this.db = deps.db ?? DatabaseConnection.getInstance().getPool();
    this.repo = deps.repo ?? new EnquadrePresenceRepository(this.db);
    this.log = deps.log ?? (logger as unknown as AdmissionLogger);
    this.dec = deps.decryptor ?? null;
  }

  async runOnce(): Promise<EnquadrePresenceSummary> {
    const summary: EnquadrePresenceSummary = { candidates: 0, measured: 0, failed: 0 };
    let due: Awaited<ReturnType<EnquadrePresenceRepository['listDueEvents']>>;
    try {
      due = await this.repo.listDueEvents();
    } catch {
      this.log.error({ reason: 'queue_failed' }, 'enquadre.presence.failed');
      return summary;
    }
    summary.candidates = due.length;
    for (const ev of due) {
      const ok = await this.measureOne(ev).catch(() => {
        this.log.error({ event_id: ev.id, reason: 'step_failed' }, 'enquadre.presence.failed');
        return false;
      });
      summary[ok ? 'measured' : 'failed'] += 1;
    }
    return summary;
  }

  private async measureOne(ev: { id: string; host_email: string; meet_space_name: string | null }): Promise<boolean> {
    if (!ev.meet_space_name) {
      this.log.warn({ event_id: ev.id, reason: 'no_space' }, 'enquadre.presence.meet_failed');
      return false;
    }
    let participants: MeetParticipant[];
    try {
      participants = await this.fetchParticipants(ev.meet_space_name, ev.host_email);
    } catch (err) {
      const reason = err instanceof MeetScopeMissingError ? err.code : err instanceof MeetTransientError ? err.reason : 'unexpected';
      this.log.warn({ event_id: ev.id, reason }, 'enquadre.presence.meet_failed');
      return false;
    }

    const convocados = await this.convocadosOf(ev.id);
    const result = decidePresence(convocados, participants);
    await withActorContext(this.db, (client) => this.repo.save(ev.id, result.byConvocado, client));

    const groups = new Map<string, { kind: string; reason: string; count: number }>();
    for (const o of result.ownerless) {
      const g = groups.get(`${o.kind}|${o.reason}`) ?? { kind: o.kind, reason: o.reason, count: 0 };
      g.count += 1;
      groups.set(`${o.kind}|${o.reason}`, g);
    }
    for (const g of groups.values()) {
      this.log.warn(
        { event_id: ev.id, participant_kind: g.kind, reason: g.reason, count: g.count, participants: result.participantCount, convocados: convocados.length },
        'enquadre.participation.unidentified',
      );
    }
    this.log.info({ event_id: ev.id, participants: result.participantCount, convocados: convocados.length, ownerless: result.ownerless.length }, 'enquadre.presence.measured');
    return true;
  }

  private async fetchParticipants(space: string, hostEmail: string): Promise<MeetParticipant[]> {
    const records = await this.deps.meet.listConferenceRecords(space, hostEmail);
    const out: MeetParticipant[] = [];
    for (const r of records) out.push(...(await this.deps.meet.listParticipants(r.name, hostEmail)));
    return out;
  }

  private async convocadosOf(eventId: string): Promise<PresenceConvocado[]> {
    const dec = (this.dec ??= new KMSEncryptionService());
    const rows = await this.repo.listConvocados(eventId);
    const out: PresenceConvocado[] = [];
    for (const r of rows) {
      out.push({ id: r.id, name: `${await dec.decrypt(r.first_name_encrypted)} ${await dec.decrypt(r.last_name_encrypted)}`.trim() });
    }
    return out;
  }
}
