/**
 * MatchmakingService
 *
 * Matching em 3 fases entre job_postings e workers:
 *
 * Fase 1 — Hard Filter (SQL)
 *   Elimina candidatos incompatíveis por occupation, funnel_stage,
 *   blacklist e sobreposição mínima de disponibilidade.
 *
 * A fase 2 (structured score) e a fase 3 (LLM via Groq) foram REMOVIDAS em
 * 23/08/2026: `useScoring` tinha default `false` e nenhum caller no repo
 * mandava `use_scoring=true`, então o caminho nunca rodava em produção — mas
 * `score()` chamava `fetch` na api.groq.com sem guarda, e o diagnóstico do
 * paciente ia no prompt. Código morto que alcança terceiro é o pior formato:
 * ninguém mantém e ninguém percebe se disparar.
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import { systemActor } from '@shared/audit/actorSource';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { DataRealm } from '@shared/domain/DataRealm';
import {
  JobPosting,
  ScoredCandidate,
  MatchResult,
  MatchOptions,
  DEFAULT_RADIUS_KM,
} from './MatchmakingTypes';
import { runHardFilterOnlyPath } from './MatchmakingHardFilterPath';
import { runHardFilter } from './MatchmakingHardFilterQuery';

export type { ScoredCandidate, MatchResult, MatchOptions } from './MatchmakingTypes';

// ─── Service ──────────────────────────────────────────────────────────────────

export class MatchmakingService {
  private db: Pool;
  private kms: KMSEncryptionService;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.kms = new KMSEncryptionService();
  }

  async matchWorkersForJob(
    jobPostingId: string,
    options: MatchOptions = {},
  ): Promise<MatchResult> {
    const topN                      = options.topN ?? 20;
    const radiusKm                  = options.radiusKm ?? DEFAULT_RADIUS_KM;
    const excludeWithActiveCases    = options.excludeWithActiveCases ?? false;
    const includeIncompleteRegister = options.includeIncompleteRegister ?? false;

    const job = await this.loadJob(jobPostingId);

    const candidates = await runHardFilter(this.db, this.kms, job, radiusKm, excludeWithActiveCases, includeIncompleteRegister);
    console.log(
      `[Matchmaking] ${candidates.length} candidatos passaram no hard filter para vaga ${jobPostingId}` +
      ` (raio: ${radiusKm}km)` +
      `${excludeWithActiveCases ? ' (excluindo com casos ativos)' : ''}`,
    );


    return runHardFilterOnlyPath(
      { kms: this.kms, saveMatchResults: this.saveMatchResults.bind(this) },
      jobPostingId, job, candidates, radiusKm, topN,
    );
  }

  // ─── Fase 1a: Carregar vaga ──────────────────────────────────────────────

  private async loadJob(jobPostingId: string): Promise<JobPosting> {
    const result = await this.db.query(
      `SELECT jp.id, jp.worker_profile_sought, jp.schedule_days_hours, jp.is_test,
              pa.lat  AS service_lat, pa.lng  AS service_lng,
              jp.required_sex, jp.required_professions,
              p.diagnosis, p.zone_neighborhood AS patient_zone
       FROM job_postings jp
       LEFT JOIN patients p ON jp.patient_id = p.id
       LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
       WHERE jp.id = $1`,
      [jobPostingId],
    );

    if (result.rows.length === 0) {
      throw new Error(`Job posting ${jobPostingId} não encontrado`);
    }

    const row = result.rows[0];
    return {
      id: row.id,
      workerProfileSought: row.worker_profile_sought,
      scheduleDaysHours: row.schedule_days_hours,
      diagnosis: row.diagnosis,
      patientZone: row.patient_zone,
      serviceLat: row.service_lat ? parseFloat(row.service_lat) : null,
      serviceLng: row.service_lng ? parseFloat(row.service_lng) : null,
      requiredSex: row.required_sex,
      requiredProfessions: Array.isArray(row.required_professions) && row.required_professions.length > 0
        ? row.required_professions as string[]
        : null,
      // pathologyTypes sourced from patients.diagnosis (jp.pathology_types dropped in migration 152)
      pathologyTypes: row.diagnosis,
      realm: DataRealm.fromIsTest(row.is_test as boolean),
    };
  }

  // ─── Persistência ─────────────────────────────────────────────────────────

  private async saveMatchResults(jobPostingId: string, candidates: ScoredCandidate[]): Promise<void> {
    // Uma transação para o lote inteiro, carimbada como rotina do sistema: sem
    // isso, cada candidato salvo pelo algoritmo entraria na medição como autor
    // desconhecido e inflaria a fatia `nao_instrumentado`.
    await withActorContext(
      this.db,
      async (client) => {
        for (const candidate of candidates) {
          // When scoring is disabled, finalScore=0 — persist as NULL so dashboards
          // can distinguish "not scored yet" from "scored 0".
          const matchScore = candidate.llmScore !== null || candidate.structuredScore !== 0
            ? candidate.finalScore
            : null;
          // F7.c (ADR-004): application_status removido. source/acquisition_channel='system' adicionados.
          await client.query(
            `INSERT INTO worker_job_applications
               (worker_id, job_posting_id, match_score, application_funnel_stage, source, acquisition_channel, internal_notes)
             VALUES ($1, $2, $3, 'INVITED', 'system', 'system', $4)
             ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
               match_score    = EXCLUDED.match_score,
               internal_notes = EXCLUDED.internal_notes,
               updated_at     = NOW()`,
            [candidate.workerId, jobPostingId, matchScore, candidate.llmReasoning],
          );
        }
      },
      systemActor('matchmaking'),
    );
  }
}
