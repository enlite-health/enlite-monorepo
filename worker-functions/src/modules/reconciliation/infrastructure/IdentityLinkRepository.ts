/**
 * IdentityLinkRepository — patient_identity_links + v_patient_source_inventory
 * (migration 297).
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { Country, InventoryBucket, LinkState, MatchKey, Source } from '../domain/enums';
import type { IdentityCandidate } from '../domain/IdentityMatcher';

export interface IdentityLink {
  readonly id: string;
  readonly source: Source;
  readonly country: Country;
  readonly externalId: string;
  readonly patientId: string | null;
  readonly matchKey: MatchKey;
  readonly state: LinkState;
  readonly candidatePatientId: string | null;
  readonly lastRunId: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
}

export interface UpsertLinkInput {
  readonly source: Source;
  readonly country: Country;
  readonly externalId: string;
  readonly patientId: string | null;
  readonly matchKey: MatchKey;
  readonly state: Exclude<LinkState, 'CONFIRMED' | 'DENIED'>;
  readonly candidatePatientId?: string | null;
  readonly lastRunId: string;
}

export interface PlatformCandidate extends IdentityCandidate {
  readonly clickupTaskId: string | null;
  readonly anaCareId: string | null;
}

export interface InventoryCounts {
  readonly onlyClickup: number;
  readonly onlyAnacare: number;
  readonly both: number;
  readonly ambiguous: number;
  readonly total: number;
}

const COLS = `id, source, country, external_id AS "externalId", patient_id AS "patientId",
  match_key AS "matchKey", state, candidate_patient_id AS "candidatePatientId",
  last_run_id AS "lastRunId", decided_by AS "decidedBy", decided_at AS "decidedAt"`;

const L_COLS = `l.id, l.source, l.country, l.external_id AS "externalId", l.patient_id AS "patientId",
  l.match_key AS "matchKey", l.state, l.candidate_patient_id AS "candidatePatientId",
  l.last_run_id AS "lastRunId", l.decided_by AS "decidedBy", l.decided_at AS "decidedAt"`;

type Q = Pick<Pool, 'query'> | PoolClient;

export class IdentityLinkRepository {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? DatabaseConnection.getInstance().getPool();
  }

  async findBySourceId(source: Source, externalId: string, q: Q = this.pool): Promise<IdentityLink | null> {
    const res = await q.query<IdentityLink>(
      `SELECT ${COLS} FROM patient_identity_links WHERE source = $1 AND external_id = $2`,
      [source, externalId],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Cria ou atualiza um link AUTOMÁTICO. Nunca toca em CONFIRMED/DENIED —
   * decisão humana prevalece sobre a chave (só atualiza last_run_id nesses).
   */
  async upsertAutomatic(input: UpsertLinkInput, q: Q = this.pool): Promise<IdentityLink> {
    const res = await q.query<IdentityLink>(
      `INSERT INTO patient_identity_links
         (source, country, external_id, patient_id, match_key, state, candidate_patient_id, last_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source, external_id) DO UPDATE SET
         patient_id           = CASE WHEN patient_identity_links.state IN ('CONFIRMED','DENIED')
                                     THEN patient_identity_links.patient_id ELSE EXCLUDED.patient_id END,
         match_key            = CASE WHEN patient_identity_links.state IN ('CONFIRMED','DENIED')
                                     THEN patient_identity_links.match_key ELSE EXCLUDED.match_key END,
         state                = CASE WHEN patient_identity_links.state IN ('CONFIRMED','DENIED')
                                     THEN patient_identity_links.state ELSE EXCLUDED.state END,
         candidate_patient_id = CASE WHEN patient_identity_links.state IN ('CONFIRMED','DENIED')
                                     THEN patient_identity_links.candidate_patient_id ELSE EXCLUDED.candidate_patient_id END,
         last_run_id          = EXCLUDED.last_run_id,
         updated_at           = NOW()
       RETURNING ${COLS}`,
      [input.source, input.country, input.externalId, input.patientId, input.matchKey, input.state,
        input.candidatePatientId ?? null, input.lastRunId],
    );
    const link = res.rows[0];
    await this.syncAnaCareId(link, q);
    return link;
  }

  /**
   * Simetria com clickup_task_id (migration 300): quando o link ANACARE está
   * AUTO/CONFIRMED com pessoa, patients.ana_care_id = external_id; DENIED limpa
   * se apontava para este id. Nunca sobrescreve um id diferente já gravado
   * (duplicata → fica para a fila; o índice único parcial protege).
   */
  private async syncAnaCareId(link: IdentityLink, q: Q): Promise<void> {
    if (link.source !== 'ANACARE') return;
    if (link.patientId && (link.state === 'AUTO' || link.state === 'CONFIRMED')) {
      await q.query(
        `UPDATE patients SET ana_care_id = $2 WHERE id = $1 AND (ana_care_id IS NULL OR ana_care_id = $2)`,
        [link.patientId, link.externalId],
      );
    } else if (link.state === 'DENIED') {
      await q.query(`UPDATE patients SET ana_care_id = NULL WHERE ana_care_id = $1`, [link.externalId]);
    }
  }

  async decide(linkId: string, state: 'CONFIRMED' | 'DENIED', actorId: string, q: Q = this.pool): Promise<IdentityLink | null> {
    const res = await q.query<IdentityLink>(
      `UPDATE patient_identity_links
          SET state = $2,
              patient_id = CASE WHEN $2 = 'CONFIRMED' THEN COALESCE(patient_id, candidate_patient_id) ELSE patient_id END,
              match_key = CASE WHEN $2 = 'CONFIRMED' THEN 'MANUAL' ELSE match_key END,
              decided_by = $3, decided_at = NOW(), updated_at = NOW()
        WHERE id = $1
       RETURNING ${COLS}`,
      [linkId, state, actorId],
    );
    const link = res.rows[0] ?? null;
    if (link) await this.syncAnaCareId(link, q);
    return link;
  }

  /** Pessoas que o Gabriel já negou para este registro (DENIED) — saem do matcher. */
  async deniedPatientIds(source: Source, externalId: string, q: Q = this.pool): Promise<Set<string>> {
    const res = await q.query<{ pid: string }>(
      `SELECT COALESCE(candidate_patient_id, patient_id) AS pid FROM patient_identity_links
        WHERE source = $1 AND external_id = $2 AND state = 'DENIED' AND COALESCE(candidate_patient_id, patient_id) IS NOT NULL`,
      [source, externalId],
    );
    return new Set(res.rows.map(r => r.pid));
  }

  /** Candidatos de identidade: pacientes vivos do país (nome/nascimento/documento — sem clínico). */
  async identityCandidates(country: Country, q: Q = this.pool): Promise<PlatformCandidate[]> {
    const res = await q.query<PlatformCandidate>(
      `SELECT id AS "patientId", first_name AS "firstName", last_name AS "lastName",
              to_char(birth_date, 'YYYY-MM-DD') AS "birthDate",
              document_type AS "documentType", document_number AS "documentNumber",
              clickup_task_id AS "clickupTaskId", ana_care_id AS "anaCareId"
         FROM patients
        WHERE deleted_at IS NULL AND country = $1`,
      [country],
    );
    return res.rows;
  }

  async inventoryCounts(country: Country): Promise<InventoryCounts> {
    const res = await this.pool.query<{ bucket: InventoryBucket; n: string }>(
      `SELECT bucket, COUNT(*)::text AS n FROM v_patient_source_inventory WHERE country = $1 GROUP BY bucket`,
      [country],
    );
    const by = Object.fromEntries(res.rows.map(r => [r.bucket, Number(r.n)])) as Partial<Record<InventoryBucket, number>>;
    const onlyClickup = by.ONLY_CLICKUP ?? 0, onlyAnacare = by.ONLY_ANACARE ?? 0, both = by.BOTH ?? 0, ambiguous = by.AMBIGUOUS ?? 0;
    return { onlyClickup, onlyAnacare, both, ambiguous, total: onlyClickup + onlyAnacare + both + ambiguous };
  }

  async listByBucket(country: Country, bucket: InventoryBucket, page: number, size: number): Promise<{ items: IdentityLink[]; total: number }> {
    const base = `FROM patient_identity_links l
       JOIN v_patient_source_inventory v
         ON v.country = l.country
        AND v.person_key = COALESCE(l.patient_id::text, l.source || ':' || l.external_id)
      WHERE l.country = $1 AND v.bucket = $2 AND l.state <> 'DENIED'`;
    const [rows, count] = await Promise.all([
      this.pool.query<IdentityLink>(
        `SELECT ${L_COLS} ${base}
          ORDER BY l.updated_at DESC LIMIT $3 OFFSET $4`,
        [country, bucket, size, (page - 1) * size],
      ),
      this.pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n ${base}`, [country, bucket]),
    ]);
    return { items: rows.rows, total: Number(count.rows[0]?.n ?? 0) };
  }
}
