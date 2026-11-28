/**
 * PgPresenceReviewEnricher — o enriquecimento da fila de revisão (emenda 077 §6): nome do prestador (KMS) e nº do caso do paciente, resolvidos SÓ na
 * leitura, sob a RLS de quem lê (`withActorContext`). O attendance devolve só ids; o turno (paciente, horário) vem do itinerário pela MESMA `ShiftDirectory`
 * do alerta (nada reimplementado). Turno que saiu do itinerário fica sem horário/caso (o item continua na fila, com o prestador). Nenhum log aqui.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { utcCivilDayOf } from '@shared/locale/civilClock';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import type { ShiftDirectory, ShiftFacts } from '../application/ports/CoordinationAlertPorts';
import { reviewItemKey, type ReviewItemEnricher, type ReviewItemFacts, type ReviewQueueEntry } from '../application/ports/PresenceReviewPorts';

const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => utcCivilDayOf(new Date(ms));

/** Janela do turno do item: o dia do turno; sem `on_date` (entrada recusada), o dia da recusa ± 1 (o turno pode virar a meia-noite). */
function windowOf(e: ReviewQueueEntry): { from: string; to: string } {
  if (e.onDate) return { from: e.onDate, to: e.onDate };
  const t = Date.parse(e.occurredAt);
  return { from: isoDay(t - DAY_MS), to: isoDay(t + DAY_MS) };
}

export class PgPresenceReviewEnricher implements ReviewItemEnricher {
  private poolMemo?: Pool;

  constructor(
    private readonly shifts: ShiftDirectory,
    pool?: Pool,
    private readonly enc: KMSEncryptionService = new KMSEncryptionService(),
  ) {
    this.poolMemo = pool;
  }

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  async enrich(items: ReadonlyArray<ReviewQueueEntry>): Promise<Map<string, ReviewItemFacts>> {
    const [names, shifts] = await Promise.all([this.workerNames([...new Set(items.map((i) => i.workerId))]), this.shiftsOf(items)]);
    const cases = await this.caseNumbers([...new Set([...shifts.values()].map((s) => s.patientId))]);
    const out = new Map<string, ReviewItemFacts>();
    for (const e of items) {
      const shift = shifts.get(e.occurrenceId);
      out.set(reviewItemKey(e), {
        workerName: names.get(e.workerId) ?? null,
        caseNumber: shift ? cases.get(shift.patientId) ?? null : null,
        startTime: shift?.startTime ?? null,
        endTime: shift?.endTime ?? null,
        onDate: shift?.onDate ?? e.onDate,
      });
    }
    return out;
  }

  /** Uma chamada da `ShiftDirectory` por janela distinta (a maioria dos itens tem `on_date`). */
  private async shiftsOf(items: ReadonlyArray<ReviewQueueEntry>): Promise<Map<string, ShiftFacts>> {
    const byWindow = new Map<string, { window: { from: string; to: string }; candidates: Array<{ occurrenceId: string; workerId: string }> }>();
    for (const e of items) {
      const window = windowOf(e);
      const key = `${window.from}|${window.to}`;
      const bucket = byWindow.get(key) ?? { window, candidates: [] };
      bucket.candidates.push({ occurrenceId: e.occurrenceId, workerId: e.workerId });
      byWindow.set(key, bucket);
    }
    const found = new Map<string, ShiftFacts>();
    for (const { window, candidates } of byWindow.values()) {
      for (const [id, facts] of await this.shifts.resolve(candidates, window)) found.set(id, facts);
    }
    return found;
  }

  private async workerNames(workerIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (workerIds.length === 0) return out;
    const { rows } = await withActorContext(this.pool, (client) =>
      client.query<{ id: string; first_name_encrypted: string | null; last_name_encrypted: string | null }>(
        `SELECT id, first_name_encrypted, last_name_encrypted FROM workers WHERE id = ANY($1::uuid[])`,
        [workerIds],
      ),
    );
    for (const r of rows) {
      const [first, last] = await Promise.all([this.enc.decrypt(r.first_name_encrypted ?? ''), this.enc.decrypt(r.last_name_encrypted ?? '')]);
      const name = [first, last].filter((s) => s && s.length > 0).join(' ');
      if (name) out.set(r.id, name);
    }
    return out;
  }

  private async caseNumbers(patientIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (patientIds.length === 0) return out;
    const { rows } = await withActorContext(this.pool, (client) =>
      client.query<{ id: string; case_number: number | null }>(`SELECT id, case_number FROM patients WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [patientIds]),
    );
    for (const r of rows) if (r.case_number !== null) out.set(r.id, Number(r.case_number));
    return out;
  }
}
