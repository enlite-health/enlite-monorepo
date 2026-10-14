import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { ENQUADRE_PRESENCE_BATCH } from '../domain/enquadreJobConfig';
import type { Ex } from '../application/ports/PostCallPorts';
import type { PresenceVerdict } from '../domain/enquadrePresence';

export interface PresenceDueEvent {
  id: string;
  host_email: string;
  meet_space_name: string | null;
}

export interface PresenceConvocadoRow {
  id: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

/** Os convocados que o evento mostra (mesmo critério da lista e do resumo): ativos, ou carimbados no encerramento/cancelamento. */
const SHOWN = `(p.release_kind IS NULL OR p.release_kind IN ('closed', 'cancelled'))`;

/**
 * EnquadrePresenceRepository — a fila e a gravação da presença (spec 052, migration 521: `attendance` e `match_method`). A fila é o
 * próprio estado: evento com fim real gravado e algum convocado com `attendance` NULL. Medida a presença, o evento sai sozinho.
 */
export class EnquadrePresenceRepository {
  constructor(
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
    private readonly batchSize: number = ENQUADRE_PRESENCE_BATCH,
  ) {}

  async listDueEvents(ex: Ex = this.db): Promise<PresenceDueEvent[]> {
    const { rows } = await ex.query<PresenceDueEvent>(
      `SELECT e.id, e.host_email, e.meet_space_name
         FROM enquadre_events e
        WHERE e.status IN ('open', 'closed')
          AND e.conference_ended_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM enquadre_event_participants p WHERE p.event_id = e.id AND ${SHOWN} AND p.attendance IS NULL)
        ORDER BY e.conference_ended_at
        LIMIT $1`,
      [this.batchSize],
    );
    return rows;
  }

  async listConvocados(eventId: string, ex: Ex = this.db): Promise<PresenceConvocadoRow[]> {
    const { rows } = await ex.query<PresenceConvocadoRow>(
      `SELECT p.id, w.first_name_encrypted, w.last_name_encrypted
         FROM enquadre_event_participants p
         JOIN workers w ON w.id = p.worker_id
        WHERE p.event_id = $1 AND ${SHOWN}
        ORDER BY p.created_at, p.id`,
      [eventId],
    );
    return rows;
  }

  /** Grava o veredito por convocado, uma vez (`attendance IS NULL`): reexecução não reescreve a medida. */
  async save(eventId: string, verdicts: ReadonlyMap<string, PresenceVerdict>, ex: Ex = this.db): Promise<void> {
    const ids = [...verdicts.keys()];
    if (ids.length === 0) return;
    await ex.query(
      `UPDATE enquadre_event_participants p
          SET attendance = v.attendance, match_method = v.match_method
         FROM unnest($2::uuid[], $3::text[], $4::text[]) AS v(id, attendance, match_method)
        WHERE p.id = v.id AND p.event_id = $1 AND p.attendance IS NULL`,
      [eventId, ids, ids.map((i) => verdicts.get(i)!.attendance), ids.map((i) => verdicts.get(i)!.matchMethod)],
    );
  }
}
