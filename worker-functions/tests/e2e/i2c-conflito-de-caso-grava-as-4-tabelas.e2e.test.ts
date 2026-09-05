/**
 * i2c-conflito-de-caso-grava-as-4-tabelas.e2e.test.ts @integration — defeito I1.
 *
 * ── O DEFEITO, medido ───────────────────────────────────────────────────────
 * `SyncPatientFromClickUpTaskUseCase.execute` devolvia `CASE_NUMBER_CONFLICT` ANTES de
 * `persistSourceLabels` / `persistInsuranceVerified` / `persistDeviceTypes` / `persistDiagnosis`.
 * Para TODA tarefa cujo `case_number` colide com outro paciente ativo, essas 4 tabelas nunca
 * eram escritas — em silêncio, a cada re-sync. Os ESCALARES eram gravados assim mesmo (o retry
 * do conflito roda `PatientService.upsertRelated`), produzindo por construção a divergência que
 * o cabeçalho do `ClickUpPatientMapper` adverte.
 *
 * O argumento do conserto já estava escrito no mesmo arquivo, sobre `syncChatIds`:
 *   "O conflito de case_number NÃO impede a ficha de existir (o upsert retenta sem o número e
 *    devolve um id real) — então os grupos espelham ANTES do early-return, senão exatamente os
 *    pacientes conflitados divergiriam do ClickUp para sempre."
 * Este teste aplica a MESMA régua às outras 4 gravações.
 *
 * ── Por que EM PROCESSO contra Postgres real ────────────────────────────────
 * O container `enlite-api` roda uma imagem ANTERIOR: e2e por HTTP não exercita este código.
 * Aqui o caminho de produção (`SyncPatientFromClickUpTaskUseCase.execute` → `PatientService`
 * real → repositórios reais → `ClickUpDiagnosisMapper` real) roda no processo do jest, contra o
 * Postgres de e2e, e a asserção LÊ AS TABELAS DE VOLTA. Molde: `tests/e2e/c1b-*.e2e.test.ts` e
 * `tests/e2e/clickup-diagnosis-sync.e2e.test.ts`.
 *
 * Nenhum dado real: nomes e rótulos são sintéticos, prefixo `I2C-`.
 */
import { Pool } from 'pg';
import { SyncPatientFromClickUpTaskUseCase } from '../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { SyncPatientDeps } from '../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import { ClickUpPatientMapper } from '../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpFieldResolver } from '../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import type { ClickUpTask } from '../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { PatientService } from '../../src/modules/case/application/PatientService';
import { PatientSourceLabelRepository } from '../../src/modules/case/infrastructure/PatientSourceLabelRepository';
import { PatientInsuranceVerifiedRepository } from '../../src/modules/case/infrastructure/PatientInsuranceVerifiedRepository';
import { PatientDeviceTypeRepository } from '../../src/modules/case/infrastructure/PatientDeviceTypeRepository';
import { ClickUpDiagnosisMapper } from '../../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisMapper';
import { ClickUpDiagnosisLabelRepository } from '../../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisLabelRepository';
import { ClickUpDiagnosisRejectionRepository } from '../../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisRejectionRepository';
import { PatientDiagnosisService } from '../../src/modules/diagnosis/application/PatientDiagnosisService';
import { PostgresPatientDiagnosisRepository } from '../../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository';
import { DiagnosisSource } from '../../src/modules/diagnosis/domain/DiagnosisSource';
import { IcdCatalogTerminology } from '../../src/modules/terminology/infrastructure/IcdCatalogTerminology';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

const TAG            = 'I2C-conflito-%';
const TASK_OCUPANTE  = 'I2C-conflito-ocupante';
const TASK_VITIMA    = 'I2C-conflito-vitima';
/** Número de caso alto de propósito: a unicidade de `case_number` é GLOBAL entre ativos. */
const CASO_DISPUTADO = 872041;

// Rótulos sintéticos que EXISTEM nos catálogos do banco de e2e (medidos por psql):
//   device_type_aliases  → 'Domiciliario' → HOME
//   clickup_diagnosis_labels → 'Trastorno Depresivo' → 6A7Z
const DISPOSITIVO_LABEL = 'Domiciliario';
const PATOLOGIA_LABEL   = 'Trastorno Depresivo';
const PATOLOGIA_CODE    = '6A7Z';
const COBERTURA_LABEL   = 'I2C-COBERTURA-SINTETICA';
const DEPENDENCIA_LABEL = 'MUY GRAVE';

const CAMPOS_LABELS = new Set(['Cobertura Verificada', 'Tipo de Dispositivo']);

/** Resolver falso, mas com a MESMA superfície do real — o mapper real o consome. */
function resolverFalso(): ClickUpFieldResolver {
  const dropdown: Record<string, Record<number, string>> = {
    'Dependencia':      { 1: DEPENDENCIA_LABEL },
    'Tipo de Patología': { 1: PATOLOGIA_LABEL },
  };
  const labels: Record<string, Record<string, string>> = {
    'Cobertura Verificada': { 'uuid-cob-1': COBERTURA_LABEL },
    'Tipo de Dispositivo':  { 'uuid-dis-1': DISPOSITIVO_LABEL },
  };
  return {
    getFieldType: (f: string) => (CAMPOS_LABELS.has(f) ? 'labels' : 'drop_down'),
    resolveDropdown: (f: string, v: number | string | null | undefined) => {
      if (v === null || v === undefined || v === '') return null;
      return dropdown[f]?.[Number(v)] ?? null;
    },
    resolveLabel: (f: string, id: string | null | undefined) => (id ? labels[f]?.[id] ?? null : null),
    resolveLabels: (f: string, ids: readonly string[] | null | undefined) =>
      (ids ?? []).map(i => labels[f]?.[i]).filter((l): l is string => Boolean(l)),
    dropdownFieldNames: Object.keys(dropdown),
    labelsFieldNames:   Object.keys(labels),
    getDropdownOptions: (f: string) => dropdown[f] ?? {},
    getLabelsOptions:   (f: string) => labels[f] ?? {},
  } as unknown as ClickUpFieldResolver;
}

function tarefaEmConflito(): ClickUpTask {
  return {
    id: TASK_VITIMA,
    name: 'Vitima, Conflito I2C',
    parent: null,
    status: { status: 'admisión' },
    custom_fields: [
      { id: 'cf-fn',  name: 'Nombre de Paciente',    value: 'ConflitoI2C' },
      { id: 'cf-ln',  name: 'Apellido del Paciente', value: 'Vitima QA' },
      { id: 'cf-wa',  name: 'Número de WhatsApp Paciente', value: '+5491133445566' },
      { id: 'cf-cas', name: 'Caso Número',           value: String(CASO_DISPUTADO) },
      { id: 'cf-dep', name: 'Dependencia',           value: 1 },
      { id: 'cf-cob', name: 'Cobertura Verificada',  value: ['uuid-cob-1'] },
      { id: 'cf-dis', name: 'Tipo de Dispositivo',   value: ['uuid-dis-1'] },
      { id: 'cf-pat', name: 'Tipo de Patología',     value: 1 },
    ],
  } as unknown as ClickUpTask;
}

describe('I1 — paciente com caso DUPLICADO recebe cobertura, dispositivo, cru e diagnóstico @integration', () => {
  let pool: Pool;
  let terminology: IcdCatalogTerminology;

  const limpar = async (): Promise<void> => {
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    // Controle positivo do AMBIENTE: sem catálogo CID-11 ingerido o passo do diagnóstico não
    // prova nada (contagem zero é falha, nunca sucesso).
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM terminology.icd_entities WHERE release = '2026-01'`,
    );
    if (rows[0].n < 30000) throw new Error(`catálogo 2026-01 ausente nesta base (${rows[0].n} linhas)`);
    terminology = new IcdCatalogTerminology();
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  beforeEach(async () => {
    await limpar();
    // O OCUPANTE do número de caso — é ele que faz o `patients_case_number_active_unique` estourar.
    await pool.query(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number)
       VALUES ($1, 'Ocupante', 'I2C QA', 'AR', 'ACTIVE', $2)`,
      [TASK_OCUPANTE, CASO_DISPUTADO],
    );
    // A cobertura sintética precisa existir como rótulo aceitável — a tabela guarda o CRU,
    // então basta o rótulo não ser vazio (nenhum ConceptMap envolvido aqui).
  });

  function useCaseReal(): SyncPatientFromClickUpTaskUseCase {
    const deps: SyncPatientDeps = {
      mapper:                new ClickUpPatientMapper(resolverFalso()),
      patientService:        new PatientService(),
      sourceLabelRepository: new PatientSourceLabelRepository(),
      insuranceRepository:   new PatientInsuranceVerifiedRepository(),
      deviceTypeRepository:  new PatientDeviceTypeRepository(),
      diagnosisMapper: new ClickUpDiagnosisMapper(
        new ClickUpDiagnosisLabelRepository(),
        new ClickUpDiagnosisRejectionRepository(),
        new PatientDiagnosisService(terminology, new PostgresPatientDiagnosisRepository(DiagnosisSource.CLICKUP)),
      ),
    };
    return new SyncPatientFromClickUpTaskUseCase(deps);
  }

  it('conflito de caso: `kind` continua CASE_NUMBER_CONFLICT E as 4 tabelas RECEBEM a linha', async () => {
    const resultado = await useCaseReal().execute(tarefaEmConflito(), { onMissingContact: 'flag' }, 'i2c-i1');

    // 1. O contrato do `kind` NÃO muda — o conserto é aditivo.
    expect(resultado.kind).toBe('CASE_NUMBER_CONFLICT');
    const patientId = (resultado as { patientId: string }).patientId;
    expect(patientId).toBeTruthy();

    // Controle positivo: a ficha existe MESMO com o conflito (o retry grava sem o número).
    const { rows: ficha } = await pool.query<{ case_number: number | null; needs_attention: boolean }>(
      'SELECT case_number, needs_attention FROM patients WHERE id = $1', [patientId]);
    expect(ficha[0]).toMatchObject({ case_number: null, needs_attention: true });

    // 2. `patient_source_labels` — o rótulo CRU de um campo de catálogo.
    const { rows: cru } = await pool.query<{ field_name: string; raw_label: string }>(
      `SELECT field_name, raw_label FROM patient_source_labels
        WHERE patient_id = $1 AND field_name = 'Dependencia'`, [patientId]);
    expect(cru).toEqual([expect.objectContaining({ raw_label: DEPENDENCIA_LABEL })]);

    // 3. `patient_insurance_verified` — a cobertura múltipla.
    const { rows: cobertura } = await pool.query<{ raw_label: string }>(
      'SELECT raw_label FROM patient_insurance_verified WHERE patient_id = $1', [patientId]);
    expect(cobertura.map(r => r.raw_label)).toEqual([COBERTURA_LABEL]);

    // 4. `patient_device_types` — o dispositivo múltiplo (código canônico via ConceptMap).
    const { rows: dispositivo } = await pool.query<{ device_type: string }>(
      'SELECT device_type FROM patient_device_types WHERE patient_id = $1', [patientId]);
    expect(dispositivo.map(r => r.device_type)).toEqual(['HOME']);

    // 5. `patient_diagnoses` — o diagnóstico CID-11 estruturado, origem CLICKUP.
    const { rows: diag } = await pool.query<{ concept_code: string; active: boolean }>(
      `SELECT concept_code, active FROM patient_diagnoses WHERE patient_id = $1 AND source = 'CLICKUP'`,
      [patientId]);
    expect(diag).toEqual([expect.objectContaining({ concept_code: PATOLOGIA_CODE, active: true })]);
  });

  it('CONTROLE POSITIVO — sem conflito de caso, as MESMAS 4 tabelas são escritas (a régua mede)', async () => {
    await pool.query('DELETE FROM patients WHERE clickup_task_id = $1', [TASK_OCUPANTE]);

    const resultado = await useCaseReal().execute(tarefaEmConflito(), { onMissingContact: 'flag' }, 'i2c-i1-ctrl');
    expect(resultado.kind).toBe('CREATED');
    const patientId = (resultado as { patientId: string }).patientId;

    const conta = async (sql: string): Promise<number> =>
      (await pool.query<{ n: number }>(sql, [patientId])).rows[0].n;

    expect(await conta(`SELECT count(*)::int AS n FROM patient_source_labels WHERE patient_id = $1 AND field_name = 'Dependencia'`)).toBe(1);
    expect(await conta('SELECT count(*)::int AS n FROM patient_insurance_verified WHERE patient_id = $1')).toBe(1);
    expect(await conta('SELECT count(*)::int AS n FROM patient_device_types WHERE patient_id = $1')).toBe(1);
    expect(await conta(`SELECT count(*)::int AS n FROM patient_diagnoses WHERE patient_id = $1 AND source = 'CLICKUP'`)).toBe(1);
  });
});
