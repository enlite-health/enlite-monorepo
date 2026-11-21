import type { Pool } from 'pg';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';
import { resourceIdHash } from '@shared/audit/resourceAccessLog';
import { withActorContext } from '@shared/database/actorContext';
import { WorkerPhoneMergeService } from '../../../infrastructure/services/WorkerPhoneMergeService';

/** D764: a ficha da conta (X) não é casca, ou difere da importada em `is_test`: nada é gravado. */
export const CLAIM_CONFLICT = 'CLAIM_CONFLICT';

/**
 * Porta: a conta que confirma o claim JÁ tem ficha (X, achada por `auth_uid`). Só a absorção segura da
 * importada na ficha X (casca) deixa o claim terminar; senão `CLAIM_CONFLICT` (nunca 500).
 */
export interface IClaimShellAbsorber {
  absorbImportedIntoExisting(args: {
    existingId: string;
    importedId: string;
    authUid: string;
    /** Instante do consentimento do OTP: gravado em X DENTRO da mesma transação da absorção. */
    consentAt: Date;
  }): Promise<Result<void>>;
}

class ClaimConflictError extends Error {}

/** Tabelas cujo conteúdo faz a ficha deixar de ser casca (documento, candidatura, encuadre, itinerário). */
const CONTENT_TABLES = [
  'worker_documents',
  'worker_additional_documents',
  'worker_job_applications',
  'encuadres',
  'patient_itinerary_assignment',
] as const;

/**
 * Implementação: UMA transação de ator (`withActorContext`, o mesmo client e o contexto de ator/país da request)
 * que trava X, confere que é casca e absorve a importada em X pelo `WorkerPhoneMergeService` (mesma trilha
 * `worker_merge_audit`, `source = claim_shell`). X é o sobrevivente: segura o `auth_uid` do token (UNIQUE) e herda
 * telefone e histórico da importada; o uid sintético dela fica na ficha absorvida, como em todo merge.
 */
export class ClaimShellAbsorber implements IClaimShellAbsorber {
  constructor(
    private readonly pool: Pool,
    private readonly mergeService: WorkerPhoneMergeService = new WorkerPhoneMergeService(),
  ) {}

  async absorbImportedIntoExisting(args: {
    existingId: string;
    importedId: string;
    authUid: string;
    consentAt: Date;
  }): Promise<Result<void>> {
    const log = logger.child({
      source: 'ClaimShellAbsorber',
      existingIdHash: resourceIdHash(args.existingId),
      importedIdHash: resourceIdHash(args.importedId),
    });
    try {
      await withActorContext(this.pool, async (client) => {
        const rows = await client.query<{ id: string; phone: string | null; is_test: boolean; merged_into_id: string | null; phone_normalized: string | null }>(
          `SELECT id, phone, is_test, merged_into_id, phone_normalized
             FROM workers WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
          [[args.existingId, args.importedId]],
        );
        const existing = rows.rows.find((r) => r.id === args.existingId);
        const imported = rows.rows.find((r) => r.id === args.importedId);
        if (!existing || !imported || existing.merged_into_id !== null || imported.merged_into_id !== null) {
          throw new ClaimConflictError('rows');
        }
        if (existing.phone && existing.phone !== '') throw new ClaimConflictError('phone');
        if (existing.is_test !== imported.is_test) throw new ClaimConflictError('is_test');
        for (const table of CONTENT_TABLES) {
          const hit = await client.query(`SELECT 1 FROM ${table} WHERE worker_id = $1 LIMIT 1`, [args.existingId]);
          if ((hit.rowCount ?? 0) > 0) throw new ClaimConflictError(table);
        }
        await this.mergeService.executeSingleMerge({
          survivorId: args.existingId,
          absorbedId: args.importedId,
          phoneNormalized: imported.phone_normalized ?? '',
          category: 'ghost',
          legalFieldExceptions: [],
          audit: { source: 'claim_shell', executedBy: args.authUid, confirmedSamePerson: true },
          client,
        });
        // Consentimento do OTP na ficha sobrevivente, na MESMA transação: só os campos de consentimento
        // (COALESCE: não sobrescreve o que já há) e NUNCA auth_uid. Falha aqui = rollback do merge inteiro.
        const consent = await client.query(
          `UPDATE workers
              SET lgpd_consent_at = COALESCE(lgpd_consent_at, $2),
                  terms_accepted_at = COALESCE(terms_accepted_at, $2),
                  privacy_accepted_at = COALESCE(privacy_accepted_at, $2)
            WHERE id = $1`,
          [args.existingId, args.consentAt],
        );
        if (consent.rowCount !== 1) throw new Error('CLAIM_CONSENT_NOT_WRITTEN');
      });
      const recalculated = await this.recalc(args.existingId);
      if (!recalculated) log.warn({ msg: 'claim_shell_status_recalc_failed' });
      log.info({ msg: 'claim_shell_absorbed' });
      return Result.ok<void>(undefined);
    } catch (err: unknown) {
      if (err instanceof ClaimConflictError) {
        // `err.message` é só o nome da checagem que barrou (sem dado da ficha).
        log.warn({ msg: 'claim_conflict', reason: err.message });
        return Result.fail<void>(CLAIM_CONFLICT);
      }
      // O texto do Postgres pode ecoar a linha (PII): só o código vai ao log e nada sai na resposta.
      const code = (err as { code?: string }).code;
      log.error({ msg: 'claim_shell_absorb_failed', pgCode: code });
      return Result.fail<void>('CLAIM_ABSORB_FAILED');
    }
  }

  private async recalc(workerId: string): Promise<boolean> {
    try {
      const { recalculateWorkerStatus } = await import('../../worker/infrastructure/WorkerStatusRepository');
      await recalculateWorkerStatus(this.pool, workerId, null);
      return true;
    } catch {
      return false;
    }
  }
}
