/**
 * MirrorWorkerService — lógica reutilizável de espelhamento worker → provider externo.
 *
 * Extraído de BackfillWorkerMirrorUseCase para reuso no handler de evento contínuo
 * (AnaCareMirrorEventHandler).
 *
 * Regras:
 *   - Se ana_care_status='Baja' e tem ana_care_id → deactivate (campo já está no banco)
 *   - Se campos mínimos presentes (firstName + lastName + sex + email) → upsert
 *   - Caso contrário → 'skipped'
 *
 * PII-SAFETY: dados decriptados NUNCA aparecem em logs nem em ana_care_sync_error.
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { normalizeSexValue } from '@shared/utils/normalizeSexValue';
import { logger, reportError } from '@shared/logging';
import type { WorkerMirrorProvider } from '../domain/WorkerMirrorProvider';
import type { WorkerMirrorRecord } from '../domain/WorkerMirrorRecord';

const TAG = '[MirrorWorkerService]';

// ─────────────────────────────────────────────────────────────────
// DB row fetched by mirrorOne
// ─────────────────────────────────────────────────────────────────

interface WorkerRow {
  id: string;
  email: string;
  phone: string | null;
  status: string;
  profession: string | null;
  occupation: string | null;
  ana_care_id: string | null;
  ana_care_status: string | null;
  is_test: boolean;
  merged_into_id: string | null;
  // Encrypted PII
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
  sex_encrypted: string | null;
  birth_date_encrypted: string | null;
  document_number_encrypted: string | null;
  // Service area (nullable)
  sa_address_line: string | null;
  sa_city: string | null;
  sa_state: string | null;
  sa_neighborhood: string | null;
  sa_postal_code: string | null;
}

export type MirrorResult = 'created' | 'updated' | 'skipped' | 'deactivated';

/**
 * Diz se um ana_care_id já está gravado em algum worker nosso — usado pelo
 * AnaCareMirrorProvider antes de linkar um match encontrado por telefone+nome,
 * pra não escrever no AnaCare e só depois esbarrar na constraint de unicidade
 * local (achado real em prod, 11/08: duplicata de cadastro com mesmo telefone).
 */
export async function isAnaCareIdClaimed(externalId: string): Promise<boolean> {
  const pool = DatabaseConnection.getInstance().getPool();
  const { rows } = await pool.query('SELECT 1 FROM workers WHERE ana_care_id = $1 LIMIT 1', [externalId]);
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────

export class MirrorWorkerService {
  private readonly db: Pool;
  private readonly encryptionService: KMSEncryptionService;
  private readonly provider: WorkerMirrorProvider;

  constructor(provider: WorkerMirrorProvider) {
    this.db = DatabaseConnection.getInstance().getPool();
    this.encryptionService = new KMSEncryptionService();
    this.provider = provider;
  }

  /**
   * Espelha um único worker no provider externo.
   *
   * @returns 'created' | 'updated' | 'skipped' | 'deactivated'
   * @throws  Em erro de rede/API (após persistir o erro no banco).
   */
  async mirrorOne(workerId: string): Promise<MirrorResult> {
    const log = logger.child({ workerId, service: 'MirrorWorkerService' });

    const row = await this.fetchWorker(workerId);
    if (!row) {
      log.warn({ msg: `${TAG} worker not found — skipping` });
      return 'skipped';
    }

    try {
      // Gate: worker de teste (is_test=true) NUNCA é enviado ao provider externo.
      // Checado ANTES de qualquer chamada externa (upsert e deactivate).
      if (row.is_test === true) {
        log.info({ msg: `${TAG} skipped (is_test)`, reason: 'is_test' });
        return 'skipped';
      }

      // Gate: cadastro FUNDIDO nunca é espelhado.
      //
      // O merge move `ana_care_id` para o sobrevivente e deixa o casco com o id
      // NULO, mas com status REGISTERED — ou seja, o casco parece elegível. Antes
      // do fallback de alias isso era inofensivo: o POST batia no conflito de
      // e-mail e morria ali. Com o alias, o casco passaria a CRIAR uma segunda
      // enfermera para uma pessoa que o sobrevivente já espelha — duplicata
      // dentro da nossa própria agência, que é pior que a duplicata entre
      // empresas que estamos aceitando de propósito.
      //
      // Caso real: worker `5ad78938` (casco) x `c744f723` (sobrevivente, já com
      // nurse 90575).
      // Truthiness de propósito: `null` (não fundido) e `undefined` (campo ausente
      // na linha) significam a MESMA coisa aqui — seguir em frente. Um `!== null`
      // trataria ausência como "fundido" e pararia de espelhar TODO mundo.
      if (row.merged_into_id) {
        log.info({ msg: `${TAG} skipped (cadastro fundido)`, reason: 'merged' });
        return 'skipped';
      }

      // Deactivate path: Baja + known external ID (independente do status REGISTERED)
      if (row.ana_care_status === 'Baja' && row.ana_care_id !== null) {
        if (this.provider.deactivate) {
          await this.provider.deactivate(row.ana_care_id);
          log.info({ msg: `${TAG} deactivated`, anaCareId: row.ana_care_id });
        } else {
          log.warn({ msg: `${TAG} deactivate not supported by provider — skipping baja` });
        }
        return 'deactivated';
      }

      // Gate: só espelha workers com status='REGISTERED'
      // Workers INCOMPLETE_REGISTER ou DISABLED recebem 'skipped'.
      // O PATCH (atualização) ainda funciona se o worker já tinha ana_care_id
      // e continua REGISTERED; se voltou a INCOMPLETE_REGISTER, skipa.
      if (row.status !== 'REGISTERED') {
        log.info({ msg: `${TAG} skipped (status is not REGISTERED)`, status: row.status });
        return 'skipped';
      }

      // Build decrypted record
      const record = await this.buildRecord(row);
      if (!record) {
        log.info({ msg: `${TAG} skipped (missing required fields: firstName/lastName/sex)` });
        return 'skipped';
      }

      const isNew = row.ana_care_id === null;
      const result = await this.provider.upsert(record, row.ana_care_id);

      await this.persistSuccess(workerId, result.externalId, result.emailAliasUsed ?? null);
      log.info({ msg: `${TAG} upserted`, action: isNew ? 'created' : 'updated' });

      return isNew ? 'created' : 'updated';
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      // PII-SAFE: só status HTTP + msg da API externa (nunca dados decriptados)
      const errorMsg = e.message.slice(0, 500);
      await this.persistError(workerId, errorMsg);
      reportError(e, { source: `${TAG}:mirrorOne`, workerId });
      throw e;
    }
  }

  // ── Record builder ──────────────────────────────────────────────

  /**
   * Decripta PII e monta WorkerMirrorRecord.
   * Retorna null se firstName, lastName ou sex estiverem ausentes.
   * PII nunca vai para logs.
   */
  async buildRecord(row: {
    id: string;
    email: string;
    phone: string | null;
    profession: string | null;
    occupation: string | null;
    first_name_encrypted: string | null;
    last_name_encrypted: string | null;
    sex_encrypted: string | null;
    birth_date_encrypted: string | null;
    document_number_encrypted: string | null;
    sa_address_line: string | null;
    sa_city: string | null;
    sa_state: string | null;
    sa_neighborhood: string | null;
    sa_postal_code: string | null;
  }): Promise<WorkerMirrorRecord | null> {
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
      // employment_type mora em worker_employment_history — omitido por ora
      employmentType: null,
    };
  }

  // ── Persistência de estado ──────────────────────────────────────

  /**
   * @param emailAlias endereço alternativo usado na criação (null = e-mail real).
   *   É gravado SEMPRE, inclusive como NULL: um worker que antes nasceu com alias
   *   e depois passou a sincronizar com o endereço real tem que sair da fila de
   *   resolução sozinho — marca que só liga e nunca desliga vira ruído.
   */
  async persistSuccess(
    workerId: string,
    externalId: string,
    emailAlias: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE workers
       SET ana_care_id          = $2,
           ana_care_synced_at   = NOW(),
           ana_care_sync_error  = NULL,
           ana_care_email_alias = $3,
           updated_at           = NOW()
       WHERE id = $1`,
      [workerId, externalId, emailAlias],
    );
  }

  async persistError(workerId: string, errorMsg: string): Promise<void> {
    await this.db.query(
      `UPDATE workers
       SET ana_care_sync_error = $2,
           updated_at          = NOW()
       WHERE id = $1`,
      [workerId, errorMsg],
    );
  }

  // ── Fetch ───────────────────────────────────────────────────────

  private async fetchWorker(workerId: string): Promise<WorkerRow | null> {
    const { rows } = await this.db.query<WorkerRow>(
      `SELECT
         w.id,
         w.email,
         w.phone,
         w.status,
         w.profession,
         w.occupation,
         w.ana_care_id,
         w.ana_care_status,
         w.is_test,
         w.merged_into_id,
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
       WHERE w.id = $1`,
      [workerId],
    );
    return rows[0] ?? null;
  }
}
