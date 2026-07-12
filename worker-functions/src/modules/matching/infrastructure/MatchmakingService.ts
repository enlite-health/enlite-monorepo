/**
 * MatchmakingService
 *
 * Matching em 3 fases entre job_postings e workers:
 *
 * Fase 1 — Hard Filter (SQL)
 *   Elimina candidatos incompatíveis por occupation, funnel_stage,
 *   blacklist e sobreposição mínima de disponibilidade.
 *
 * Fase 2 — Structured Score (em memória, 0-100)
 *   Scoring determinístico: occupation, geo, diagnósticos, rejection history.
 *
 * Fase 3 — LLM Score (top N candidatos, 0-100)
 *   MatchmakingLLMScorer chama Groq com perfil completo.
 *   Descriptografa sex/nome via KMS apenas para esses N workers.
 *
 * Score final = structured_score * 0.35 + llm_score * 0.65
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { DataRealm } from '@shared/domain/DataRealm';
import {
  JobPosting,
  WorkerCandidate,
  ScoredCandidate,
  MatchResult,
  MatchOptions,
  DEFAULT_RADIUS_KM,
  registrationWarning,
} from './MatchmakingTypes';
import { MatchmakingLLMScorer } from './MatchmakingLLMScorer';
import { computeStructuredScore } from './MatchmakingStructuredScorer';
import { runHardFilterOnlyPath } from './MatchmakingHardFilterPath';
import { runHardFilter } from './MatchmakingHardFilterQuery';

export type { ScoredCandidate, MatchResult, MatchOptions } from './MatchmakingTypes';

// ─── Service ──────────────────────────────────────────────────────────────────

export class MatchmakingService {
  private db: Pool;
  private kms: KMSEncryptionService;
  private llmScorer: MatchmakingLLMScorer;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.kms = new KMSEncryptionService();
    this.llmScorer = new MatchmakingLLMScorer(
      process.env.GROQ_API_KEY ?? '',
      process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
    );
  }

  async matchWorkersForJob(
    jobPostingId: string,
    options: MatchOptions = {},
  ): Promise<MatchResult> {
    const topN                      = options.topN ?? 20;
    const radiusKm                  = options.radiusKm ?? DEFAULT_RADIUS_KM;
    const excludeWithActiveCases    = options.excludeWithActiveCases ?? false;
    const useScoring                = options.useScoring ?? false;
    const includeIncompleteRegister = options.includeIncompleteRegister ?? false;

    const job = await this.loadJob(jobPostingId);

    const candidates = await runHardFilter(this.db, this.kms, job, radiusKm, excludeWithActiveCases, includeIncompleteRegister);
    console.log(
      `[Matchmaking] ${candidates.length} candidatos passaram no hard filter para vaga ${jobPostingId}` +
      ` (raio: ${radiusKm}km)` +
      `${excludeWithActiveCases ? ' (excluindo com casos ativos)' : ''}` +
      `${useScoring ? '' : ' [SCORING DISABLED]'}`,
    );


    if (!useScoring) {
      return runHardFilterOnlyPath(
        { kms: this.kms, saveMatchResults: this.saveMatchResults.bind(this) },
        jobPostingId, job, candidates, radiusKm, topN,
      );
    }

    const rankedByStructured = candidates
      .map(w => {
        const { score: structuredScore, distanceKm } = computeStructuredScore(w, job);
        return { worker: w, structuredScore, distanceKm };
      })
      .sort((a, b) => b.structuredScore - a.structuredScore)
      .slice(0, topN);

    console.log(`[Matchmaking] Rodando LLM para ${rankedByStructured.length} candidatos...`);

    const finalCandidates: ScoredCandidate[] = [];

    for (const { worker, structuredScore, distanceKm } of rankedByStructured) {
      const [firstName, lastName, sex] = await Promise.all([
        this.kms.decrypt(worker.firstNameEncrypted),
        this.kms.decrypt(worker.lastNameEncrypted),
        this.kms.decrypt(worker.sexEncrypted),
      ]);

      const nameParts = firstName === lastName
        ? [firstName].filter(Boolean)
        : [firstName, lastName].filter(Boolean);
      const workerName = nameParts.join(' ') || 'Sin nombre';

      let llmScore: number | null = null;
      let llmReasoning: string | null = null;
      let llmRedFlags: string[] = [];
      let llmStrengths: string[] = [];

      try {
        const llmResult = await this.llmScorer.score(job, worker, sex ?? '', distanceKm, worker.activeCases);
        llmScore = llmResult.score;
        llmReasoning = llmResult.reasoning;
        llmRedFlags = llmResult.red_flags;
        llmStrengths = llmResult.strengths;
      } catch (err) {
        console.error(`[Matchmaking] LLM falhou para worker ${worker.workerId}:`, (err as Error).message);
      }

      const finalScore =
        llmScore !== null
          ? Math.round(structuredScore * 0.35 + llmScore * 0.65)
          : structuredScore;

      finalCandidates.push({
        workerId: worker.workerId,
        workerName,
        workerPhone: worker.phone,
        occupation: worker.occupation,
        workZone: worker.workZone ?? worker.workerAddress,
        distanceKm: distanceKm !== null ? Math.round(distanceKm * 10) / 10 : null,
        activeCasesCount: worker.activeCases.length,
        workerStatus: worker.workerStatus,
        registrationWarning: registrationWarning(worker.workerStatus),
        structuredScore,
        llmScore,
        finalScore,
        llmReasoning,
        llmRedFlags,
        llmStrengths,
        alreadyApplied: worker.alreadyApplied,
      });

      await sleep(100); // Rate limit Groq free: 30 req/min
    }

    finalCandidates.sort((a, b) => b.finalScore - a.finalScore);
    await this.saveMatchResults(jobPostingId, finalCandidates);

    return {
      jobPostingId,
      radiusKm,
      matchSummary: {
        hardFilteredCount: candidates.length,
        llmScoredCount: finalCandidates.filter(c => c.llmScore !== null).length,
      },
      candidates: finalCandidates,
    };
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
    for (const candidate of candidates) {
      // When scoring is disabled, finalScore=0 — persist as NULL so dashboards
      // can distinguish "not scored yet" from "scored 0".
      const matchScore = candidate.llmScore !== null || candidate.structuredScore !== 0
        ? candidate.finalScore
        : null;
      // F7.c (ADR-004): application_status removido. source/acquisition_channel='system' adicionados.
      await this.db.query(
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
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
