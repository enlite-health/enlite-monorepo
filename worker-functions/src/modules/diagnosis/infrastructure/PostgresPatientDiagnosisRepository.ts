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
import type {
  NewPatientDiagnosisInput,
  PatientDiagnosisRepositoryPort,
} from '../domain/PatientDiagnosisRepositoryPort';

export class PatientDiagnosisNotFoundInScopeError extends Error {
  constructor(id: string, scope: DiagnosisSource) {
    super(`Diagnóstico ${id} não encontrado no escopo de origem ${scope.value}`);
    this.name = 'PatientDiagnosisNotFoundInScopeError';
  }
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
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async demotePrimary(patientId: string): Promise<void> {
    await this.runner.query(
      `UPDATE patient_diagnoses SET is_primary = false, updated_at = NOW()
        WHERE patient_id = $1 AND source = $2 AND is_primary AND active`,
      [patientId, this.scope.value],
    );
  }

  async promotePrimary(id: string, actorUid: string): Promise<PatientDiagnosis> {
    const { rows } = await this.runner.query<PatientDiagnosisRow>(
      `UPDATE patient_diagnoses SET is_primary = true, updated_by = $3, updated_at = NOW()
        WHERE id = $1 AND source = $2 AND active
        RETURNING *`,
      [id, this.scope.value, actorUid],
    );
    if (!rows[0]) throw new PatientDiagnosisNotFoundInScopeError(id, this.scope);
    return toEntity(rows[0]);
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
