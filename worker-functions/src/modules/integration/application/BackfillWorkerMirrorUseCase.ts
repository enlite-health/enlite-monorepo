/**
 * BackfillWorkerMirrorUseCase — espelha workers elegíveis para um provider externo.
 *
 * dryRun=true (default): apenas conta e loga o que seria enviado, SEM rede.
 * dryRun=false: chama provider.upsert(), persiste ana_care_id/ana_care_synced_at.
 *
 * Elegibilidade:
 *   - status = 'REGISTERED'
 *   - merged_into_id IS NULL
 *   - email NOT LIKE '%@enlite.import' (workers sintéticos de import)
 *   - phone_normalized NÃO em grupo de colisão não resolvida (duplicados por phone)
 *
 * Endereço: JOIN worker_service_areas ORDER BY created_at ASC LIMIT 1 (mais antiga =
 * principal, convenção; não existe is_primary).
 *
 * PII-SAFETY: campos decriptados NUNCA aparecem em logs nem em ana_care_sync_error.
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { normalizeSexValue } from '@shared/utils/normalizeSexValue';
import { logger, reportError } from '@shared/logging';
import type { WorkerMirrorProvider } from '../domain/WorkerMirrorProvider';
import type { WorkerMirrorRecord } from '../domain/WorkerMirrorRecord';

const TAG = '[BackfillWorkerMirror]';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface BackfillOptions {
  /** dryRun=true (padrão): não faz rede, só conta/loga */
  dryRun?: boolean;
  /** Máximo de workers a processar nesta execução */
  limit?: number;
}

export interface BackfillSummary {
  eligible: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ workerId: string; message: string }>;
}

// ─────────────────────────────────────────────────────────────────
// Eligible worker row from DB
// ─────────────────────────────────────────────────────────────────

interface EligibleWorkerRow {
  id: string;
  email: string;
  phone: string | null;
  profession: string | null;
  occupation: string | null;
  ana_care_id: string | null;
  // Encrypted fields — decripted inline
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  sex_encrypted: string | null;
  birth_date_encrypted: string | null;
  document_number_encrypted: string | null;
  // Service area (nullable — worker pode não ter ainda)
  sa_address_line: string | null;
  sa_city: string | null;
  sa_state: string | null;
  sa_neighborhood: string | null;
  sa_postal_code: string | null;
}

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class BackfillWorkerMirrorUseCase {
  private readonly db: Pool;
  private readonly encryptionService: KMSEncryptionService;
  private readonly providerFactory: () => Promise<WorkerMirrorProvider>;

  /**
   * @param providerFactory cria o provider SOB DEMANDA — só é chamado quando há
   *   upsert real (dryRun=false). Em dryRun nenhum client externo é instanciado
   *   (sem Secret Manager / sem KMS), então o preview roda em qualquer ambiente.
   */
  constructor(providerFactory: () => Promise<WorkerMirrorProvider>) {
    this.db = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
    this.providerFactory = providerFactory;
  }

  async execute(opts: BackfillOptions = {}): Promise<BackfillSummary> {
    const dryRun = opts.dryRun !== false; // default: true
    const limit = opts.limit ?? 500;

    logger.info({ msg: `${TAG} starting`, dryRun, limit });

    const rows = await this.fetchEligibleWorkers(limit);
    const summary: BackfillSummary = {
      eligible: rows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };

    logger.info({ msg: `${TAG} eligible workers found`, count: rows.length, dryRun });

    // dryRun: preview puro — NÃO decripta PII nem cria client externo.
    // Conta novo (POST) vs existente (PATCH) apenas por ana_care_id.
    if (dryRun) {
      for (const row of rows) {
        if (row.ana_care_id) { summary.updated++; } else { summary.created++; }
      }
      logger.info({ msg: `${TAG} dryRun done`, ...summary });
      return summary;
    }

    const provider = await this.providerFactory();

    for (const row of rows) {
      const log = logger.child({ workerId: row.id });
      try {
        const record = await this.buildRecord(row);
        if (!record) {
          summary.skipped++;
          log.info({ msg: `${TAG} skipped (missing required fields for provider)` });
          continue;
        }

        const isNew = row.ana_care_id === null;
        const result = await provider.upsert(record, row.ana_care_id);

        await this.persistSuccess(row.id, result.externalId);

        if (isNew) { summary.created++; } else { summary.updated++; }
        log.info({ msg: `${TAG} upserted`, action: isNew ? 'created' : 'updated' });
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        // PII-SAFE: só status HTTP + msg da API externa (não dados decriptados)
        const errorMsg = e.message.slice(0, 500);
        summary.errors.push({ workerId: row.id, message: errorMsg });
        await this.persistError(row.id, errorMsg);
        reportError(e, { source: `${TAG}:processWorker`, workerId: row.id });
      }
    }

    logger.info({
      msg: `${TAG} done`,
      provider: provider.name,
      dryRun,
      ...summary,
      errorCount: summary.errors.length,
    });

    return summary;
  }

  // ── Query de elegibilidade ────────────────────────────────────────

  private async fetchEligibleWorkers(limit: number): Promise<EligibleWorkerRow[]> {
    // Exclui workers em grupo de colisão de phone NÃO resolvida (duplicados reais):
    //   GROUP BY phone_normalized HAVING count(*) > 1 entre não-merged.
    // phone_normalized é a coluna gerada canônica de dedup (migration 219).
    // colonia ← neighborhood (barrio, mig 110); endereço da service area principal
    // (mais antiga = principal, convenção; não há is_primary).
    const { rows } = await this.db.query<EligibleWorkerRow>(
      `SELECT
         w.id,
         w.email,
         w.phone,
         w.profession,
         w.occupation,
         w.ana_care_id,
         w.first_name_encrypted,
         w.last_name_encrypted,
         w.sex_encrypted,
         w.birth_date_encrypted,
         w.document_number_encrypted,
         sa.address_line   AS sa_address_line,
         sa.city           AS sa_city,
         sa.state          AS sa_state,
         sa.neighborhood   AS sa_neighborhood,
         sa.postal_code    AS sa_postal_code
       FROM workers w
       LEFT JOIN LATERAL (
         SELECT address_line, city, state, neighborhood, postal_code
         FROM worker_service_areas
         WHERE worker_id = w.id AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT 1
       ) sa ON TRUE
       WHERE w.status = 'REGISTERED'
         AND w.merged_into_id IS NULL
         AND w.email NOT LIKE '%@enlite.import'
         AND (
           w.phone_normalized IS NULL
           OR w.phone_normalized NOT IN (
             SELECT phone_normalized
             FROM workers
             WHERE merged_into_id IS NULL AND phone_normalized IS NOT NULL
             GROUP BY phone_normalized
             HAVING count(*) > 1
           )
         )
       ORDER BY w.created_at ASC
       LIMIT $1`,
      [limit],
    );
    return rows;
  }

  // ── Record builder ────────────────────────────────────────────────

  /**
   * Decripta PII e constrói WorkerMirrorRecord.
   * Retorna null se campos obrigatórios (firstName, lastName, sex) estiverem ausentes.
   * PII NUNCA vai para logs.
   */
  private async buildRecord(row: EligibleWorkerRow): Promise<WorkerMirrorRecord | null> {
    const [firstName, lastName, sexRaw, birthDate, documentNumber] = await Promise.all([
      row.first_name_encrypted
        ? this.encryptionService.decrypt(row.first_name_encrypted)
        : Promise.resolve(null),
      row.last_name_encrypted
        ? this.encryptionService.decrypt(row.last_name_encrypted)
        : Promise.resolve(null),
      row.sex_encrypted
        ? this.encryptionService.decrypt(row.sex_encrypted)
        : Promise.resolve(null),
      row.birth_date_encrypted
        ? this.encryptionService.decrypt(row.birth_date_encrypted)
        : Promise.resolve(null),
      row.document_number_encrypted
        ? this.encryptionService.decrypt(row.document_number_encrypted)
        : Promise.resolve(null),
    ]);

    const sex = normalizeSexValue(sexRaw);

    // Campos obrigatórios para o provider AnaCare: nome, sexo, email já temos
    if (!firstName || !lastName || !sex) {
      return null;
    }

    return {
      workerId: row.id,
      firstName,
      lastName,
      sex,
      email: row.email,
      phone: row.phone ?? null,
      birthDate: birthDate ?? null,
      documentNumber: documentNumber ?? null,
      address: {
        line: row.sa_address_line ?? null,
        city: row.sa_city ?? null,
        state: row.sa_state ?? null,
        neighborhood: row.sa_neighborhood ?? null,
        postalCode: row.sa_postal_code ?? null,
      },
      profession: row.profession ?? null,
      occupation: row.occupation ?? null,
      // employment_type não é coluna de workers (mora em worker_employment_history);
      // tipo_contratacion fica pendente do catálogo da Ana — omitido por ora.
      employmentType: null,
    };
  }

  // ── Persistência de estado ────────────────────────────────────────

  private async persistSuccess(workerId: string, externalId: string): Promise<void> {
    await this.db.query(
      `UPDATE workers
       SET ana_care_id        = $2,
           ana_care_synced_at = NOW(),
           ana_care_sync_error = NULL,
           updated_at          = NOW()
       WHERE id = $1`,
      [workerId, externalId],
    );
  }

  private async persistError(workerId: string, errorMsg: string): Promise<void> {
    await this.db.query(
      `UPDATE workers
       SET ana_care_sync_error = $2,
           updated_at          = NOW()
       WHERE id = $1`,
      [workerId, errorMsg],
    );
  }
}
