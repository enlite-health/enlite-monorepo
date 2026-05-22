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
import {
  JobPosting,
  WorkerCandidate,
  ScoredCandidate,
  MatchResult,
  MatchOptions,
  DEFAULT_RADIUS_KM,
  registrationWarning,
  haversineKm,
} from './MatchmakingTypes';
import { MatchmakingLLMScorer } from './MatchmakingLLMScorer';
import { computeStructuredScore } from './MatchmakingStructuredScorer';
import { runHardFilterOnlyPath } from './MatchmakingHardFilterPath';

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

    const candidates = await this.hardFilter(job, radiusKm, excludeWithActiveCases, includeIncompleteRegister);
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
      `SELECT jp.id, jp.worker_profile_sought, jp.schedule_days_hours,
              pa.lat  AS service_lat, pa.lng  AS service_lng,
              jp.required_sex, jp.required_professions,
              p.diagnosis, pa.neighborhood AS patient_zone
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
    };
  }

  // ─── Fase 1b: Hard filter via SQL ────────────────────────────────────────

  private async hardFilter(
    job: JobPosting,
    radiusKm: number | null,
    excludeWithActiveCases: boolean,
    includeIncompleteRegister: boolean = false,
  ): Promise<WorkerCandidate[]> {
    const requiredProfession = job.requiredProfessions;
    const applyGeo = radiusKm !== null && job.serviceLat !== null && job.serviceLng !== null;

    const result = await this.db.query(
      `SELECT
         w.id                                     AS worker_id,
         w.phone,
         w.occupation,
         w.status                                 AS worker_status,
         COALESCE(w.diagnostic_preferences, '{}') AS diagnostic_preferences,
         w.sex_encrypted,
         w.first_name_encrypted,
         w.last_name_encrypted,
         wsa.work_zone,
         wsa.address_line                         AS worker_address,
         wsa.interest_zone,
         wsa.latitude                             AS worker_lat,
         wsa.longitude                            AS worker_lng,
         (
           SELECT COALESCE(json_agg(json_build_object(
             'case_number', jp2.case_number,
             'schedule_text', jp2.schedule_days_hours
           )), '[]'::json)
           FROM encuadres ea
           JOIN job_postings jp2 ON jp2.id = ea.job_posting_id
           WHERE ea.worker_id = w.id
             AND ea.resultado = 'SELECCIONADO'
             AND jp2.is_covered = false
         ) AS active_cases,
         EXISTS (
           SELECT 1 FROM worker_job_applications wja
           WHERE wja.worker_id = w.id AND wja.job_posting_id = $1
         ) AS already_applied,
         (
           SELECT COALESCE(json_object_agg(rej.cat, rej.cnt), '{}'::json)
           FROM (
             SELECT rejection_reason_category AS cat, COUNT(*)::integer AS cnt
             FROM encuadres e_rej
             WHERE e_rej.worker_id = w.id
               AND e_rej.rejection_reason_category IS NOT NULL
             GROUP BY rejection_reason_category
           ) rej
         ) AS rejection_history,
         w.avg_quality_rating
       FROM workers w
       LEFT JOIN blacklist bl ON bl.worker_id = w.id
       LEFT JOIN worker_service_areas wsa ON wsa.worker_id = w.id AND wsa.deleted_at IS NULL
       WHERE w.merged_into_id IS NULL
         AND w.status = ANY($8::text[])
         AND w.deleted_at IS NULL
         AND bl.id IS NULL
         AND (
           $2::JSONB IS NULL
           OR $2::JSONB ? COALESCE(w.occupation, w.profession)
         )
         AND wsa.location IS NOT NULL
         AND NOT (wsa.latitude = 0 AND wsa.longitude = 0)
         AND (
           NOT $3::BOOLEAN
           OR ST_DWithin(
             wsa.location,
             ST_MakePoint($4::FLOAT, $5::FLOAT)::geography,
             $6::FLOAT * 1000
           )
         )
         AND (
           NOT $7::BOOLEAN
           OR NOT EXISTS (
             SELECT 1 FROM encuadres ea2
             JOIN job_postings jp3 ON jp3.id = ea2.job_posting_id
             WHERE ea2.worker_id = w.id
               AND ea2.resultado = 'SELECCIONADO'
               AND jp3.is_covered = false
           )
         )
       GROUP BY w.id, wsa.work_zone, wsa.address_line, wsa.interest_zone, wsa.latitude, wsa.longitude`,
      [
        job.id,
        requiredProfession !== null ? JSON.stringify(requiredProfession) : null,
        applyGeo,
        applyGeo ? job.serviceLng : 0,
        applyGeo ? job.serviceLat : 0,
        radiusKm ?? 0,
        excludeWithActiveCases,
        includeIncompleteRegister
          ? ['REGISTERED', 'INCOMPLETE_REGISTER']
          : ['REGISTERED'],
      ],
    );

    const candidates: WorkerCandidate[] = result.rows.map(row => ({
      workerId: row.worker_id as string,
      phone: row.phone as string,
      occupation: row.occupation as string | null,
      workerStatus: row.worker_status as string | null,
      diagnosticPreferences: (row.diagnostic_preferences as string[]) ?? [],
      sexEncrypted: row.sex_encrypted as string | null,
      firstNameEncrypted: row.first_name_encrypted as string | null,
      lastNameEncrypted: row.last_name_encrypted as string | null,
      workZone: row.work_zone as string | null,
      workerAddress: row.worker_address as string | null,
      interestZone: row.interest_zone as string | null,
      activeCases: (row.active_cases as WorkerCandidate['activeCases']) ?? [],
      workerLat: row.worker_lat ? parseFloat(row.worker_lat as string) : null,
      workerLng: row.worker_lng ? parseFloat(row.worker_lng as string) : null,
      alreadyApplied: row.already_applied as boolean,
      rejectionHistory: (row.rejection_history as Record<string, number>) ?? {},
      avgQualityRating: row.avg_quality_rating ? parseFloat(row.avg_quality_rating as string) : null,
    }));

    const requiredSexCode = normalizeSexCode(job.requiredSex);

    const filteredCandidates: WorkerCandidate[] = [];
    for (const candidate of candidates) {
      // Sex match (conservador): vaga BOTH/null aceita qualquer; vaga M/F
      // exige worker com sex cadastrado E batendo. Worker sem sex_encrypted
      // (null) é EXCLUÍDO quando a vaga restringe.
      // Normaliza ambos os lados pra evitar mismatch entre forma curta da
      // vaga ('M'/'F') e forma extensa do worker ('male'/'female') —
      // o sex_encrypted é gravado como palavra completa lowercase em
      // produção mas required_sex usa single-letter uppercase.
      if (requiredSexCode) {
        if (!candidate.sexEncrypted) continue;
        const workerSex = await this.kms.decrypt(candidate.sexEncrypted);
        const workerSexCode = normalizeSexCode(workerSex);
        if (workerSexCode !== requiredSexCode) continue;
      }
      // Distance: só exclui se TODOS os 4 (vaga lat+lng, worker lat+lng)
      // estão presentes E a distância passa do raio. Worker sem coords ou
      // vaga sem coords → mantém candidato (distance unknown).
      if (
        radiusKm !== null &&
        job.serviceLat !== null && job.serviceLng !== null &&
        candidate.workerLat !== null && candidate.workerLng !== null
      ) {
        const distance = haversineKm(job.serviceLat, job.serviceLng, candidate.workerLat, candidate.workerLng);
        if (distance > radiusKm) continue;
      }
      filteredCandidates.push(candidate);
    }

    return filteredCandidates;
  }

  // ─── Persistência ─────────────────────────────────────────────────────────

  private async saveMatchResults(jobPostingId: string, candidates: ScoredCandidate[]): Promise<void> {
    for (const candidate of candidates) {
      // When scoring is disabled, finalScore=0 — persist as NULL so dashboards
      // can distinguish "not scored yet" from "scored 0".
      const matchScore = candidate.llmScore !== null || candidate.structuredScore !== 0
        ? candidate.finalScore
        : null;
      await this.db.query(
        `INSERT INTO worker_job_applications
           (worker_id, job_posting_id, match_score, application_status, application_funnel_stage, internal_notes)
         VALUES ($1, $2, $3, 'under_review', 'INVITED', $4)
         ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
           match_score    = EXCLUDED.match_score,
           internal_notes = EXCLUDED.internal_notes,
           updated_at     = NOW()`,
        [candidate.workerId, jobPostingId, matchScore, candidate.llmReasoning],
      );
    }
  }
}

/**
 * Normaliza um valor de sexo para o canônico interno 'M' | 'F' | null.
 * Aceita as várias formas que aparecem em produção:
 *   - vaga.required_sex: 'M', 'F', 'MALE', 'FEMALE' (UPPERCASE inglês curto/extenso)
 *   - sex_encrypted decifrado: 'male', 'female' (lowercase inglês)
 *   - eventual entrada manual: 'masculino', 'femenino', 'femenina'
 * Retorna null pra valores desconhecidos / vazios / 'BOTH' / 'OTHER'.
 */
function normalizeSexCode(value: string | null | undefined): 'M' | 'F' | null {
  if (!value) return null;
  const v = value.trim().toUpperCase();
  if (v === 'M' || v === 'MALE' || v === 'MASCULINO') return 'M';
  if (v === 'F' || v === 'FEMALE' || v === 'FEMENINO' || v === 'FEMENINA') return 'F';
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
