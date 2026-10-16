import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { IMPORT_MIN_DELAY_MS } from '../domain/admissionImport';
import { ENQUADRE_IMPORT_BATCH } from '../domain/enquadreJobConfig';
import { MODEL_SIDE_SUMMARY_FAILURES, SUMMARY_ATTEMPTS_EXHAUSTED } from '../application/ports/AdmissionImportPorts';
import type { ImportSource, ImportState, ImportSubject } from '../application/ports/ImportPorts';
import type { Ex } from '../application/ports/PostCallPorts';

/**
 * O evento como a importação o enxerga: o `ImportSubject` da admissão, com `admission_code` = o `ENC-` do evento, `slot_start` = o
 * horário marcado e `country` do evento. `status` é MAPEADO: evento `open`/`closed` = `booked` (encerrar na tela NÃO impede de
 * importar a call; o serviço só aceita `booked`), `cancelled` fica `cancelled`. Sem paciente: `patient_is_test` é sempre `false`.
 */
export type EnquadreImportSubject = ImportSubject;

/**
 * EnquadreImportRepository — a FONTE da importação do Tactiq do enquadre (porto `ImportSource`) sobre `enquadre_events` (spec 052,
 * migrations 518 e 521), SEM `JOIN` em paciente. Lote próprio (`ENQUADRE_IMPORT_BATCH`); a exclusão mútua por evento é o advisory
 * lock de sessão do serviço (`enquadre_import:<id>`). Os registros auxiliares (`hasEvent`, tentativas de resumo) leem a trilha
 * `enquadre_event_trail`. O relógio entra por parâmetro.
 */
export class EnquadreImportRepository implements ImportSource<EnquadreImportSubject> {
  constructor(
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
    private readonly batchSize: number = ENQUADRE_IMPORT_BATCH,
  ) {}

  /**
   * Devidos: evento `open`/`closed` COM o fim real gravado há mais de 10 min e ainda não terminal (`blocked` volta à fila: o vínculo do
   * Tactiq pode ter sido refeito). Os que esgotaram as tentativas de resumo (`summary_attempts_exhausted` na trilha) saem — o enquadre
   * não tem botão de reprocesso. `FOR UPDATE ... SKIP LOCKED`: um evento com escrita em curso (outra transação) não entra no lote.
   */
  async listDueIds(now: Date, limit: number = this.batchSize, ex: Ex = this.db): Promise<string[]> {
    const { rows } = await ex.query<{ id: string }>(
      `SELECT e.id FROM enquadre_events e
        WHERE e.status IN ('open', 'closed')
          AND e.conference_ended_at IS NOT NULL
          AND e.conference_ended_at <= $1::timestamptz - make_interval(secs => $3::double precision)
          AND e.import_status IN ('pending', 'waiting', 'blocked')
          AND NOT EXISTS (SELECT 1 FROM enquadre_event_trail t WHERE t.event_id = e.id AND t.kind = 'import_blocked' AND t.reason = $4)
        ORDER BY e.conference_ended_at
        LIMIT $2
          FOR UPDATE OF e SKIP LOCKED`,
      [now, limit, IMPORT_MIN_DELAY_MS / 1000, SUMMARY_ATTEMPTS_EXHAUSTED],
    );
    return rows.map((r) => r.id);
  }

  async find(id: string, ex: Ex = this.db): Promise<EnquadreImportSubject | null> {
    const { rows } = await ex.query<EnquadreImportSubject>(
      `SELECT e.id, e.country, e.host_email, e.event_code AS admission_code, e.starts_at AS slot_start,
              CASE WHEN e.status IN ('open', 'closed') THEN 'booked' ELSE e.status END AS status,
              e.conference_ended_at, e.import_status, e.import_attempts::int AS import_attempts,
              FALSE AS patient_is_test, NULL::timestamptz AS rehearsal_until
         FROM enquadre_events e
        WHERE e.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Sai do `blocked` = o motivo some (o CHECK da 521 amarra `blocked_reason` ao estado). Com `transcript` (só no `done`) grava o nome do
   * objeto e o sha256 do cofre — nunca o texto.
   */
  async setState(
    id: string,
    state: ImportState,
    ex: Ex,
    opts: { countAttempt?: boolean; reason?: string; transcript?: { objectName: string; sha256: string } } = {},
  ): Promise<void> {
    await ex.query(
      `UPDATE enquadre_events
          SET import_status = $2::text,
              import_attempts = import_attempts + $3,
              blocked_reason = CASE WHEN $2::text = 'blocked' THEN $4::text ELSE NULL END,
              transcript_object_path = COALESCE($5::text, transcript_object_path),
              transcript_sha256 = COALESCE($6::text, transcript_sha256)
        WHERE id = $1`,
      [id, state, opts.countAttempt ? 1 : 0, opts.reason ?? null, opts.transcript?.objectName ?? null, opts.transcript?.sha256 ?? null],
    );
  }

  async hasEvent(eventId: string, kind: string, ex: Ex = this.db): Promise<boolean> {
    const { rows } = await ex.query(`SELECT 1 FROM enquadre_event_trail WHERE event_id = $1 AND kind = $2 LIMIT 1`, [eventId, kind]);
    return rows.length > 0;
  }

  /** O enquadre não tem reino de teste/ensaio (sem paciente): nunca há `skipped_test`. */
  async hasSkippedTest(): Promise<boolean> {
    return false;
  }

  async hasBlockedReason(eventId: string, reason: string, ex: Ex = this.db): Promise<boolean> {
    const { rows } = await ex.query(`SELECT 1 FROM enquadre_event_trail WHERE event_id = $1 AND kind = 'import_blocked' AND reason = $2 LIMIT 1`, [eventId, reason]);
    return rows.length > 0;
  }

  /** Tentativas de resumo que chegaram ao Vertex (teto de 3), pela trilha. Sem autorização de reprocesso: conta desde sempre. */
  async countModelSummaryFailures(eventId: string, ex: Ex = this.db): Promise<number> {
    const { rows } = await ex.query<{ n: string }>(
      `SELECT count(*) AS n FROM enquadre_event_trail WHERE event_id = $1 AND kind = 'summary_failed' AND reason = ANY($2::text[])`,
      [eventId, MODEL_SIDE_SUMMARY_FAILURES],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
