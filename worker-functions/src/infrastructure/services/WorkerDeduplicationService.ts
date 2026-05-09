/**
 * WorkerDeduplicationService
 *
 * Detecta e mescla workers duplicados usando:
 *   1. SQL fuzzy matching (CUIT, levenshtein em telefone, trigram em nome)
 *   2. LLM (Groq/Llama) para confirmar duplicata e decidir qual dado é mais completo
 *   3. Merge atômico em transação PostgreSQL
 *
 * REGRA DE COMPLEMENTAÇÃO:
 *   Ex: Ana Care tem telefone "1151265663" (10 dígitos, faltando prefixo)
 *       Talentum tem telefone "5491151265663" (13 dígitos, correto)
 *   → LLM reconhece que é o mesmo número e elege o de 13 dígitos como canônico.
 *
 * LLM logic (prompts, parseLLMResponse) lives in WorkerDedupLLM.ts.
 */

import { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { AnalyticsRepository, DuplicateCandidate } from '../repositories/AnalyticsRepository';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { analyzeWithLLM, parseLLMResponse } from './WorkerDedupLLM';

// ─── Tipos ────────────────────────────────────────────────────────────────

export interface DuplicateAnalysis {
  isSamePerson: boolean;
  confidence: number;       // 0.0 – 1.0
  explanation: string;
  preferredPhone: 1 | 2 | null;
  preferredEmail: 1 | 2 | null;
  preferredFirstName: 1 | 2 | null;
  preferredLastName: 1 | 2 | null;
  preferredCuit: 1 | 2 | null;
  mergedPhone: string | null;
  mergedEmail: string;
  mergedFirstName: string | null;
  mergedLastName: string | null;
  mergedCuit: string | null;
}

export interface DeduplicationResult {
  worker1Id: string;
  worker2Id: string;
  matchReason: string;
  analysis: DuplicateAnalysis;
  merged: boolean;
  canonicalId: string | null;
  error: string | null;
}

export interface DeduplicationReport {
  candidatesFound: number;
  analyzed: number;
  mergesExecuted: number;
  mergesSkipped: number;
  errors: number;
  details: DeduplicationResult[];
}

// ─── Service ──────────────────────────────────────────────────────────────

export class WorkerDeduplicationService {
  private pool: Pool;
  private analyticsRepo: AnalyticsRepository;
  private encryptionService: KMSEncryptionService;
  private blindIndexService: BlindIndexService;
  private apiKey: string;
  private model: string;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
    this.analyticsRepo = new AnalyticsRepository();
    this.encryptionService = new KMSEncryptionService();
    this.blindIndexService = new BlindIndexService();
    this.apiKey  = process.env.GROQ_API_KEY ?? '';
    this.model   = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile';
  }

  // ── Pipeline principal ────────────────────────────────────────────────────

  async runDeduplication(options: {
    dryRun?: boolean;
    confidence?: number;
    limit?: number;
  } = {}): Promise<DeduplicationReport> {
    const { dryRun = false, confidence = 0.85, limit = 20 } = options;

    if (!this.apiKey) {
      throw new Error('GROQ_API_KEY não configurado. Obter em https://console.groq.com');
    }

    const candidates = await this.analyticsRepo.findDuplicateCandidates(limit);
    console.log(`[Dedup] ${candidates.length} candidatos encontrados para análise`);

    const report: DeduplicationReport = {
      candidatesFound: candidates.length,
      analyzed: 0, mergesExecuted: 0, mergesSkipped: 0, errors: 0, details: [],
    };

    for (const pair of candidates) {
      await this.processPair(pair, report, { dryRun, confidence });
    }

    console.log(`[Dedup] Concluído | analisados: ${report.analyzed} | merges: ${report.mergesExecuted} | erros: ${report.errors}`);
    return report;
  }

  // ── Pipeline escopo: workers recém-importados ─────────────────────────────

  async runDeduplicationForWorkers(
    workerIds: string[],
    options: { dryRun?: boolean; confidence?: number } = {},
  ): Promise<DeduplicationReport> {
    const empty: DeduplicationReport = {
      candidatesFound: 0, analyzed: 0, mergesExecuted: 0,
      mergesSkipped: 0, errors: 0, details: [],
    };
    if (workerIds.length === 0) return empty;

    if (!this.apiKey) {
      throw new Error('GROQ_API_KEY não configurado. Obter em https://console.groq.com');
    }

    const { dryRun = false, confidence = 0.85 } = options;
    const unique = [...new Set(workerIds)];
    const candidates = await this.analyticsRepo.findDuplicateCandidatesForWorkers(unique);
    console.log(`[Dedup] ${candidates.length} candidatos para ${unique.length} workers importados`);

    const report: DeduplicationReport = { ...empty, candidatesFound: candidates.length };

    for (const pair of candidates) {
      await this.processPair(pair, report, { dryRun, confidence });
    }

    console.log(`[Dedup] Concluído | analisados: ${report.analyzed} | merges: ${report.mergesExecuted} | erros: ${report.errors}`);
    return report;
  }

  // ── Shared pair-processing loop ───────────────────────────────────────────

  private async processPair(
    pair: DuplicateCandidate,
    report: DeduplicationReport,
    opts: { dryRun: boolean; confidence: number },
  ): Promise<void> {
    const result: DeduplicationResult = {
      worker1Id:   pair.worker1Id,
      worker2Id:   pair.worker2Id,
      matchReason: pair.matchReason,
      analysis:    null as unknown as DuplicateAnalysis,
      merged:      false,
      canonicalId: null,
      error:       null,
    };

    try {
      console.log(`[Dedup] Analisando par: ${pair.worker1Id} × ${pair.worker2Id} (${pair.matchReason})`);
      const analysis = await this.analyzeWithLLM(pair);
      result.analysis = analysis;
      report.analyzed++;

      if (analysis.isSamePerson && analysis.confidence >= opts.confidence) {
        if (!opts.dryRun) {
          const canonicalId = await this.chooseCanonical(pair.worker1Id, pair.worker2Id);
          const duplicateId = canonicalId === pair.worker1Id ? pair.worker2Id : pair.worker1Id;
          await this.mergeWorkers(canonicalId, duplicateId, {
            phone: analysis.mergedPhone, email: analysis.mergedEmail,
            firstName: analysis.mergedFirstName, lastName: analysis.mergedLastName,
            cuit: analysis.mergedCuit,
          });
          result.merged      = true;
          result.canonicalId = canonicalId;
          report.mergesExecuted++;
          console.log(`[Dedup] MERGE: canonical=${canonicalId}, duplicate=${duplicateId} (confidence=${analysis.confidence})`);
        } else {
          result.canonicalId = pair.worker1Id;
          report.mergesSkipped++;
          console.log(`[Dedup] DRY-RUN: mergearia ${pair.worker1Id} ← ${pair.worker2Id} (confidence=${analysis.confidence})`);
        }
      } else {
        report.mergesSkipped++;
        console.log(`[Dedup] SKIP: isSame=${analysis.isSamePerson}, confidence=${analysis.confidence}`);
      }

      await sleep(150); // rate limit Groq free: 30 req/min
    } catch (err) {
      result.error = (err as Error).message;
      report.errors++;
      console.error(`[Dedup] Erro no par ${pair.worker1Id} × ${pair.worker2Id}:`, (err as Error).message);
    }

    report.details.push(result);
  }

  // ── Análise LLM (delegated) ───────────────────────────────────────────────

  async analyzeWithLLM(pair: DuplicateCandidate): Promise<DuplicateAnalysis> {
    return analyzeWithLLM(pair, this.apiKey, this.model);
  }

  // ── Merge atômico ─────────────────────────────────────────────────────────

  async mergeWorkers(
    canonicalId: string,
    duplicateId: string,
    resolvedData: {
      phone: string | null;
      email: string;
      firstName: string | null;
      lastName: string | null;
      cuit: string | null;
    },
  ): Promise<void> {
    const [encryptedFirstName, encryptedLastName, nameBidxBuffers] = await Promise.all([
      resolvedData.firstName ? this.encryptionService.encrypt(resolvedData.firstName) : Promise.resolve(null),
      resolvedData.lastName  ? this.encryptionService.encrypt(resolvedData.lastName)  : Promise.resolve(null),
      this.blindIndexService.generateNameTrigramBidx(resolvedData.firstName, resolvedData.lastName),
    ]);
    const nameBidxLiteral = this.blindIndexService.serializeForPg(nameBidxBuffers);

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Atualiza canônico com dados mesclados (deliberado — não COALESCE para nome/bidx)
      await client.query(
        `UPDATE workers SET
           phone                = COALESCE($2, phone),
           email                = COALESCE($3, email),
           first_name_encrypted = COALESCE($4, first_name_encrypted),
           last_name_encrypted  = COALESCE($5, last_name_encrypted),
           cuit                 = COALESCE($6, cuit),
           name_trgm_bidx       = $8::bytea[],
           data_sources = ARRAY(
             SELECT DISTINCT unnest(
               array_cat(
                 COALESCE(data_sources, '{}'),
                 (SELECT COALESCE(data_sources, '{}') FROM workers WHERE id = $7)
               )
             )
           ),
           updated_at = NOW()
         WHERE id = $1`,
        [canonicalId, resolvedData.phone, resolvedData.email,
         encryptedFirstName, encryptedLastName, resolvedData.cuit,
         duplicateId, nameBidxLiteral],
      );

      // 2a. Re-linka encuadres
      await client.query(
        'UPDATE encuadres SET worker_id = $1 WHERE worker_id = $2',
        [canonicalId, duplicateId],
      );

      // 2b. Re-linka worker_job_applications (ignora conflitos de unique)
      await client.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_status, application_funnel_stage, source)
         SELECT $1, job_posting_id, application_status, application_funnel_stage, source
         FROM worker_job_applications WHERE worker_id = $2
         ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
        [canonicalId, duplicateId],
      );
      await client.query(
        'DELETE FROM worker_job_applications WHERE worker_id = $1',
        [duplicateId],
      );

      // 2c. Re-linka blacklist (ignora conflitos de unique worker_id+reason)
      await client.query(
        `INSERT INTO blacklist (worker_id, worker_raw_name, worker_raw_phone, reason, reason_encrypted, detail, detail_encrypted, registered_by, can_take_eventual)
         SELECT $1, worker_raw_name, worker_raw_phone, reason, reason_encrypted, detail, detail_encrypted, registered_by, can_take_eventual
         FROM blacklist WHERE worker_id = $2
         ON CONFLICT (worker_id, reason) WHERE worker_id IS NOT NULL DO NOTHING`,
        [canonicalId, duplicateId],
      );
      await client.query(
        'DELETE FROM blacklist WHERE worker_id = $1',
        [duplicateId],
      );

      // 3. Marca duplicado como mesclado
      await client.query(
        `UPDATE workers SET merged_into_id = $1, updated_at = NOW() WHERE id = $2`,
        [canonicalId, duplicateId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async chooseCanonical(id1: string, id2: string): Promise<string> {
    const result = await this.pool.query(
      `SELECT id, created_at
       FROM workers WHERE id IN ($1, $2)
       ORDER BY (first_name_encrypted IS NOT NULL) DESC, created_at ASC
       LIMIT 1`,
      [id1, id2],
    );
    return result.rows[0]?.id ?? id1;
  }

  /** Exposed for tests that access via (service as any).parseLLMResponse */
  parseLLMResponse(raw: Parameters<typeof parseLLMResponse>[0]): DuplicateAnalysis {
    return parseLLMResponse(raw);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
