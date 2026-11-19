import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import {
  enquadreEventPhase,
  eventCounters,
  participantColumn,
  type ColumnedParticipant,
  type EnquadreEventPhase,
  type EnquadreEventStatus,
} from '../domain/enquadreEvent';
import { getAdmissionCountryConfig, isAdmissionCountry, type AdmissionCountry } from '../domain/admissionCountries';
import { parseEnquadreSearch } from '../domain/enquadreListQuery';
import {
  EnquadreEventListRepository,
  type EnquadreListRow,
  type EnquadreParticipantStageRow,
} from '../infrastructure/EnquadreEventListRepository';
import { inZone } from './EnquadreEventService';

/**
 * Lista GLOBAL de enquadres (spec 076): uma página + os totais do conjunto filtrado inteiro, na mesma transação.
 * Forma da resposta = contrato do plano §5. Sem nome de paciente, de convocado, e-mail (nem `host_email`) ou telefone (FR-21).
 */

export interface EnquadreGlobalListItem {
  id: string;
  jobPostingId: string;
  caseNumber: number | null;
  caseOrdinal: number | null;
  eventCode: string;
  startsAt: string;
  endsAt: string;
  country: AdmissionCountry;
  hostName: string;
  status: EnquadreEventStatus;
  phase: EnquadreEventPhase;
  convokedCount: number;
  /** Mesmas colunas e a mesma regra do kanban do evento (`participantColumn` + `eventCounters`). */
  selectedCount: number;
  quickResponseCount: number;
  rejectedCount: number;
  importBlocked: { reason: string } | null;
}

export interface EnquadreGlobalList {
  items: EnquadreGlobalListItem[];
  total: number;
  convokedTotal: number;
  hosts: string[];
  range: { from: string; to: string; defaulted: boolean };
}

export interface EnquadreGlobalListInput {
  countries: string[];
  from: string | null;
  to: string | null;
  statuses: EnquadreEventStatus[] | null;
  host: string | null;
  q: string | null;
  limit: number;
  offset: number;
}

export interface EnquadreEventGlobalListDeps {
  db: Pool;
  repo?: Pick<EnquadreEventListRepository, 'list' | 'listParticipantStages'>;
  now?: () => Date;
}

/**
 * País do evento, EXPLÍCITO: valor fora de `AdmissionCountry` é erro (nunca "cai em AR" calado, que daria o fuso errado).
 * A mensagem leva só o código do país — sem PII. O módulo não tem `assertNever`; o padrão é o guard `isAdmissionCountry`.
 */
function toAdmissionCountry(value: string | null): AdmissionCountry {
  if (value !== null && isAdmissionCountry(value)) return value;
  throw new Error(`Enquadre event with unsupported country: ${String(value)}`);
}

function groupByEvent(rows: EnquadreParticipantStageRow[]): Map<string, EnquadreParticipantStageRow[]> {
  const byEvent = new Map<string, EnquadreParticipantStageRow[]>();
  for (const r of rows) byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r]);
  return byEvent;
}

export class EnquadreEventGlobalList {
  private readonly repo: Pick<EnquadreEventListRepository, 'list' | 'listParticipantStages'>;
  private readonly now: () => Date;

  constructor(private readonly deps: EnquadreEventGlobalListDeps) {
    this.repo = deps.repo ?? new EnquadreEventListRepository();
    this.now = deps.now ?? (() => new Date());
  }

  async execute(input: EnquadreGlobalListInput): Promise<EnquadreGlobalList> {
    const search = parseEnquadreSearch(input.q);
    const { rows, stages } = await withActorContext(this.deps.db, async (client) => {
      const listed = await this.repo.list(client, {
        countries: input.countries,
        from: input.from,
        to: input.to,
        statuses: input.statuses,
        host: input.host,
        eventCodeLike: search.eventCode ? `%${search.eventCode}%` : null,
        digitsLike: search.digits ? `%${search.digits}%` : null,
        ordinal: search.ordinal ?? null,
        limit: input.limit,
        offset: input.offset,
      });
      const pageIds = listed.flatMap((r) => (r.id === null ? [] : [r.id]));
      const stages = pageIds.length === 0 ? [] : await this.repo.listParticipantStages(client, pageIds);
      return { rows: listed, stages };
    });
    const stagesByEvent = groupByEvent(stages);
    const head = rows[0];
    const now = this.now();
    return {
      items: rows.filter((r) => r.id !== null).map((r) => this.toItem(r, now, stagesByEvent.get(r.id as string) ?? [])),
      total: head?.total ?? 0,
      convokedTotal: head?.convoked_total ?? 0,
      hosts: head?.hosts ?? [],
      range: { from: head?.range_from ?? '', to: head?.range_to ?? '', defaulted: input.from === null },
    };
  }

  private toItem(r: EnquadreListRow, now: Date, stages: EnquadreParticipantStageRow[]): EnquadreGlobalListItem {
    const country = toAdmissionCountry(r.country);
    const tz = getAdmissionCountryConfig(country).timezone;
    const status = r.status as EnquadreEventStatus;
    const participants: ColumnedParticipant[] = stages.map((p) => ({
      column: participantColumn({ eventStatus: status, currentStage: p.stage, outcome: p.outcome }),
      outcome: p.outcome,
    }));
    const { columns } = eventCounters(participants);
    return {
      id: r.id as string,
      jobPostingId: r.job_posting_id as string,
      caseNumber: r.case_number,
      caseOrdinal: r.case_ordinal,
      eventCode: r.event_code as string,
      startsAt: inZone(r.starts_at as Date, tz),
      endsAt: inZone(r.ends_at as Date, tz),
      country,
      hostName: r.host_display_name as string,
      status,
      phase: enquadreEventPhase(status, r.ends_at as Date, now),
      convokedCount: r.convoked ?? 0,
      selectedCount: columns.SELECTED,
      quickResponseCount: columns.QUICK_RESPONSE_TEAM,
      rejectedCount: columns.REJECTED,
      importBlocked: r.import_status === 'blocked' && r.blocked_reason ? { reason: r.blocked_reason } : null,
    };
  }
}
