/**
 * PostgresPatientDiagnosisRepository — Adapter (GoF) + Repository sobre `patient_diagnoses`
 * (migration 325, spec 016 F2, D263).
 *
 * 🔑 ESCOPO DE ORIGEM por CONSTRUTOR, não por `if`: `new PostgresPatientDiagnosisRepository(pool,
 * DiagnosisSource.CLICKUP)` e toda ESCRITA (`create`, `promotePrimary`, `demotePrimary`,
 * `deactivate`) ganha `AND source = $escopo` — o escritor do ClickUp fica FISICAMENTE incapaz de
 * mutar uma linha PANEL (a query nem ACHA a linha; 0 rows affected, nunca "encontrei e ignorei").
 * `findById` também é escopado (mesma física: nem consegue LER uma linha para depois mutá-la por
 * engano). A ÚNICA leitura deliberadamente global é `listForPatient` — a ficha do paciente
 * precisa mostrar diagnósticos de TODAS as origens (com o campo `source` dizendo qual é qual);
 * ver COMMENT no port (`domain/PatientDiagnosisRepositoryPort.ts`).
 *
 * `withTransaction` existe porque o índice parcial único "um principal por origem" (migration
 * 325) NÃO é DEFERRABLE — `SetPrimaryDiagnosis`/`RecordPatientDiagnosis` (ao criar já como
 * principal) precisam de DUAS statements (rebaixar, depois promover/criar) na MESMA transação.
 *
 * 🔒 Regra dura do "Contrato de arquitetura": só a porta, o adaptador (deste módulo:
 * `terminology/infrastructure`) e a migration conhecem o vocabulário/release. `application/` e
 * `domain/` NUNCA nomeiam o vocabulário literal — por isso `TERMINOLOGY_SYSTEM` é uma constante
 * DESTE arquivo (infraestrutura), nunca um campo de `NewPatientDiagnosisInput`.
 */
const TERMINOLOGY_SYSTEM = 'ICD-11';
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { IcdCode } from '../../terminology/domain/IcdCode';
import { PatientDiagnosis } from '../domain/PatientDiagnosis';
import type { Country, ConceptLanguage, TerminologySystem } from '../domain/PatientDiagnosis';
import { DiagnosisSource } from '../domain/DiagnosisSource';
import {
  DuplicateActiveDiagnosisError,
  PrimaryDiagnosisConflictError,
  type NewPatientDiagnosisInput,
  type PatientDiagnosisRepositoryPort,
} from '../domain/PatientDiagnosisRepositoryPort';

export class PatientDiagnosisNotFoundInScopeError extends Error {
  constructor(id: string, scope: DiagnosisSource) {
    super(`Diagnóstico ${id} não encontrado no escopo de origem ${scope.value}`);
    this.name = 'PatientDiagnosisNotFoundInScopeError';
  }
}

const PRIMARY_UNIQUE_INDEX = 'uq_patient_diagnoses_primary_por_origem';
/**
 * 🔧 F5-CORREÇÃO T5 — o SEGUNDO índice único da migration 325 (linhas 158-160). Ele existe
 * desde o primeiro dia e NÃO era reconhecido: `isPrimaryUniqueViolation` só olhava o de
 * principal, então o 23505 do dedupe subia cru e virava HTTP 500 no lugar do 409
 * `DIAGNOSIS_ALREADY_ACTIVE`. Nomear o índice por CONSTANTE (não por string solta no `if`) é o
 * mesmo remédio da correção C6 em `InsuranceProviderRepository`: ler a CONSTRAINT, nunca
 * assumir que "todo 23505 é o mesmo 23505".
 */
const DUPLICATE_ACTIVE_UNIQUE_INDEX = 'uq_patient_diagnoses_codigo_ativo_por_origem';

function violatedIndex(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const pgErr = err as { code?: unknown; constraint?: unknown };
  if (pgErr.code !== '23505') return undefined;
  return typeof pgErr.constraint === 'string' ? pgErr.constraint : undefined;
}

/** `error.code` 23505 (unique_violation) do Postgres, restrito ao índice de principal único. */
function isPrimaryUniqueViolation(err: unknown): boolean {
  return violatedIndex(err) === PRIMARY_UNIQUE_INDEX;
}

/** T5 — 23505 do índice de DEDUPE por código ativo (o segundo, que escapava como 500). */
function isDuplicateActiveViolation(err: unknown): boolean {
  return violatedIndex(err) === DUPLICATE_ACTIVE_UNIQUE_INDEX;
}

interface PatientDiagnosisRow {
  id: string;
  patient_id: string;
  terminology_system: string;
  concept_uri: string;
  concept_code: string;
  concept_title: string;
  concept_language: string;
  concept_group: string;
  catalog_release: string;
  source: string;
  is_primary: boolean;
  active: boolean;
  ended_at: Date | null;
  country: string;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

function toEntity(row: PatientDiagnosisRow): PatientDiagnosis {
  return PatientDiagnosis.reconstruct({
    id: row.id,
    patientId: row.patient_id,
    terminologySystem: row.terminology_system as TerminologySystem,
    conceptUri: row.concept_uri,
    conceptCode: IcdCode.parse(row.concept_code),
    conceptTitle: row.concept_title,
    conceptLanguage: row.concept_language as ConceptLanguage,
    conceptGroup: row.concept_group,
    catalogRelease: row.catalog_release,
    source: DiagnosisSource.parse(row.source),
    isPrimary: row.is_primary,
    active: row.active,
    endedAt: row.ended_at,
    country: row.country as Country,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class PostgresPatientDiagnosisRepository implements PatientDiagnosisRepositoryPort {
  private poolMemo: Pool | undefined;

  /** `client` só é passado internamente por `withTransaction` — nunca por quem consome a porta. */
  constructor(
    private readonly scope: DiagnosisSource,
    private readonly client?: PoolClient,
  ) {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /** Roda no client da transação corrente, se houver; senão no pool. */
  private get runner(): Pool | PoolClient {
    return this.client ?? this.pool;
  }

  async patientExists(patientId: string): Promise<boolean> {
    const { rows } = await this.runner.query('SELECT 1 FROM patients WHERE id = $1', [patientId]);
    return rows.length > 0;
  }

  async create(input: NewPatientDiagnosisInput): Promise<PatientDiagnosis> {
    try {
      const { rows } = await this.runner.query<PatientDiagnosisRow>(
        `INSERT INTO patient_diagnoses
           (patient_id, terminology_system, concept_uri, concept_code, concept_title,
            concept_language, concept_group, catalog_release, source, is_primary,
            created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
         RETURNING *`,
        [
          input.patientId,
          TERMINOLOGY_SYSTEM,
          input.conceptUri,
          input.conceptCode,
          input.conceptTitle,
          input.conceptLanguage,
          input.conceptGroup,
          input.catalogRelease,
          this.scope.value,
          input.isPrimary,
          input.actorUid,
        ],
      );
      return toEntity(rows[0]);
    } catch (err) {
      // C1 — ver PrimaryDiagnosisConflictError: nunca deixa o 23505 cru subir como 500.
      if (isPrimaryUniqueViolation(err)) throw new PrimaryDiagnosisConflictError(input.patientId);
      // T5 — o SEGUNDO índice único (dedupe por código ativo) também é traduzido; era ele que
      // escapava cru e virava 500 num webhook repetido / duplo clique.
      if (isDuplicateActiveViolation(err)) throw new DuplicateActiveDiagnosisError(input.patientId);
      throw err;
    }
  }

  async findById(id: string): Promise<PatientDiagnosis | null> {
    const { rows } = await this.runner.query<PatientDiagnosisRow>(
      'SELECT * FROM patient_diagnoses WHERE id = $1 AND source = $2',
      [id, this.scope.value],
    );
    return rows[0] ? toEntity(rows[0]) : null;
  }

  /** Deliberadamente GLOBAL — nunca filtra por origem. Ver cabeçalho do arquivo. */
  async listForPatient(patientId: string): Promise<PatientDiagnosis[]> {
    const { rows } = await this.runner.query<PatientDiagnosisRow>(
      'SELECT * FROM patient_diagnoses WHERE patient_id = $1 ORDER BY created_at ASC',
      [patientId],
    );
    return rows.map(toEntity);
  }

  async findActiveByConceptCode(patientId: string, conceptCode: string): Promise<PatientDiagnosis | null> {
    const { rows } = await this.runner.query<PatientDiagnosisRow>(
      'SELECT * FROM patient_diagnoses WHERE patient_id = $1 AND source = $2 AND concept_code = $3 AND active',
      [patientId, this.scope.value, conceptCode],
    );
    return rows[0] ? toEntity(rows[0]) : null;
  }

  async withTransaction<T>(fn: (tx: PatientDiagnosisRepositoryPort) => Promise<T>): Promise<T> {
    // Já dentro de uma transação (chamada aninhada) — reusa o MESMO client, sem BEGIN duplo.
    if (this.client) return fn(this);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new PostgresPatientDiagnosisRepository(this.scope, client);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // 🔧 F5-CORREÇÃO T8 — um ROLLBACK que FALHA (conexão derrubada, transação já abortada)
      // substituía o erro ORIGINAL. Quem chama decide o HTTP por `instanceof`
      // (`PrimaryDiagnosisConflictError` em SetPrimaryDiagnosis/RecordPatientDiagnosis): com o
      // erro trocado, o `instanceof` erra e o cliente recebe 500 no lugar de 409. O irmão do
      // mesmo PR já fazia certo (`ReadonlyDbQueryService`: `.catch(() => undefined)`).
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * C1 (QA-caça): lock consultivo POR PACIENTE — mesmo padrão de
   * `PatientInsuranceVerifiedRepository`/`PatientDeviceTypeRepository` (`pg_advisory_xact_lock`,
   * 6 arquivos de `src/` já usam). A 2ª transação concorrente bloqueia até a 1ª dar
   * COMMIT/ROLLBACK, e só então enxerga o estado final — nunca mais duas em paralelo achando
   * "não há" ao mesmo tempo. `_xact_` (não `pg_advisory_lock`): solta sozinho no fim da
   * transação, mesmo em erro; nada fica preso além da vida do client.
   *
   * 🔧 T5 — virou método da PORTA porque o lock deixou de servir só à troca de principal: o
   * dedupe de `RecordPatientDiagnosis` (`findActiveByConceptCode` → `create`) é o MESMO TOCTOU e
   * precisa da MESMA chave. Uma chave só por paciente, um lugar só que a constrói.
   */
  async lockForPatient(patientId: string): Promise<void> {
    await this.runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`diagnosis_primary:${patientId}`]);
  }

  async demotePrimary(patientId: string): Promise<void> {
    await this.lockForPatient(patientId);
    await this.runner.query(
      `UPDATE patient_diagnoses SET is_primary = false, updated_at = NOW()
        WHERE patient_id = $1 AND source = $2 AND is_primary AND active`,
      [patientId, this.scope.value],
    );
  }

  async promotePrimary(id: string, actorUid: string): Promise<PatientDiagnosis> {
    try {
      const { rows } = await this.runner.query<PatientDiagnosisRow>(
        `UPDATE patient_diagnoses SET is_primary = true, updated_by = $3, updated_at = NOW()
          WHERE id = $1 AND source = $2 AND active
          RETURNING *`,
        [id, this.scope.value, actorUid],
      );
      if (!rows[0]) throw new PatientDiagnosisNotFoundInScopeError(id, this.scope);
      return toEntity(rows[0]);
    } catch (err) {
      // C1 — defesa em profundidade (ver PrimaryDiagnosisConflictError); o lock em demotePrimary
      // já torna este 23505 inatingível pela aplicação em uso normal.
      if (isPrimaryUniqueViolation(err)) throw new PrimaryDiagnosisConflictError(id);
      throw err;
    }
  }

  async deactivate(id: string, actorUid: string): Promise<PatientDiagnosis> {
    const { rows } = await this.runner.query<PatientDiagnosisRow>(
      `UPDATE patient_diagnoses
          SET active = false, is_primary = false, ended_at = NOW(), updated_by = $3, updated_at = NOW()
        WHERE id = $1 AND source = $2 AND active
        RETURNING *`,
      [id, this.scope.value, actorUid],
    );
    if (!rows[0]) throw new PatientDiagnosisNotFoundInScopeError(id, this.scope);
    return toEntity(rows[0]);
  }
}
