/**
 * unr-patologia-ilegivel-fica-em-lista.e2e.test.ts @integration
 *
 * ── O DEFEITO QUE ISTO FECHA ────────────────────────────────────────────────
 * Quando uma OPÇÃO de "Tipo de Patología" deixa de resolver (o orderindex não existe mais no
 * catálogo do ClickUp — opção renomeada, reordenada ou apagada), a I3 já fez o passo PARAR e
 * gritar (`clickup_patient_sync.diagnosis_unreadable`, nível de erro). O que ela NÃO fez foi
 * registrar a ocorrência em lugar durável: a regra do projeto é que **o que não mapeia fica em
 * LISTA**, e a LISTA (`patient_source_label_rejections`) ficava VAZIA justamente para a classe
 * inteira dos orderindex ilegíveis. Log some por retenção; a LISTA é o que a operação lê.
 *
 * O que travou os dois agentes anteriores: `recordUnmapped(patientId, rawLabel)` exige
 * `raw_label` — e aqui NÃO EXISTE rótulo. O único "valor" disponível é o próprio orderindex,
 * que é dado clínico em forma codificada: gravá-lo violaria a regra dura de que texto clínico
 * não sai do perímetro, e fabricar um sentinela seria inventar dado em tabela clínica.
 *
 * ⇒ O caminho novo registra a OCORRÊNCIA sem registrar o VALOR: `reason='unreadable'`,
 *   `raw_label IS NULL` (migration 329 relaxa o NOT NULL SÓ para este motivo, e o CHECK novo
 *   torna estruturalmente impossível gravar rótulo junto de 'unreadable').
 *
 * ── O QUE ESTE ARQUIVO AFIRMA ───────────────────────────────────────────────
 *  1. ILEGÍVEL           → EXISTE linha de rejeição, e ela NÃO contém o orderindex nem rótulo.
 *  2. CONTROLE POSITIVO  → "rótulo existe mas não está no mapa" continua gravando `raw_label`.
 *  3. CONTROLE NEGATIVO  → campo genuinamente vazio NÃO gera linha (ausência legítima, D167).
 *
 * Em processo contra o Postgres de e2e — o container `enlite-api` roda imagem ANTERIOR, então
 * e2e por HTTP não exercitaria este código. Molde: `i2c-opcao-que-nao-resolve-nao-apaga.e2e.ts`.
 */
import { Pool } from 'pg';
import { PatientDiagnosisService } from '../../src/modules/diagnosis/application/PatientDiagnosisService';
import { PostgresPatientDiagnosisRepository } from '../../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository';
import { DiagnosisSource } from '../../src/modules/diagnosis/domain/DiagnosisSource';
import { IcdCatalogTerminology } from '../../src/modules/terminology/infrastructure/IcdCatalogTerminology';
import { ClickUpDiagnosisMapper } from '../../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisMapper';
import { ClickUpDiagnosisLabelRepository } from '../../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisLabelRepository';
import { ClickUpDiagnosisRejectionRepository } from '../../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisRejectionRepository';
import { ClickUpPatientMapper } from '../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { SyncPatientFromClickUpTaskUseCase } from '../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { SyncPatientDeps } from '../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { PatientService } from '../../src/modules/case/application/PatientService';
import type { ClickUpFieldResolver } from '../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import type { ClickUpTask } from '../../src/modules/integration/infrastructure/clickup/ClickUpTask';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

const RUN         = Date.now();
const TASK_PREFIX = `UNR-${RUN}-`;
const TAG         = 'UNR-%';
const PATOLOGIA   = 'Tipo de Patología';

/** Rótulo REAL do dropdown, COM linha em `clickup_diagnosis_labels` (migration 327). */
const LABEL_MAPEADO     = 'Trastorno Depresivo';
/** Rótulo que o ClickUp resolve e que o mapa NÃO conhece → `reason='unmapped'`, com raw_label. */
const LABEL_NAO_MAPEADO = `Rotulo Fantasma UNR ${RUN}`;

const IDX_MAPEADO     = 0;
const IDX_NAO_MAPEADO = 1;
/**
 * O orderindex que o catálogo do ClickUp NÃO traduz mais (opção renomeada/apagada).
 * Valor deliberadamente distintivo: as asserções varrem a linha inteira atrás desta string,
 * e um número curto daria falso positivo dentro de um uuid.
 */
const IDX_ILEGIVEL = 987654;

const OPCOES: Record<number, string> = {
  [IDX_MAPEADO]:     LABEL_MAPEADO,
  [IDX_NAO_MAPEADO]: LABEL_NAO_MAPEADO,
};

/** Resolver falso: o CAMPO continua `drop_down` (o preflight da 1.11 passa); a OPÇÃO é que
 *  pode não resolver — que é exatamente o estado "opção renomeada no ClickUp". */
function resolverFalso(): ClickUpFieldResolver {
  return {
    getFieldType: () => 'drop_down',
    resolveDropdown: (f: string, v: number | string | null | undefined) => {
      if (v === null || v === undefined || v === '') return null;
      if (f !== PATOLOGIA) return null;
      return OPCOES[Number(v)] ?? null;
    },
    resolveLabel:  () => null,
    resolveLabels: () => [],
  } as unknown as ClickUpFieldResolver;
}

function tarefa(taskId: string, orderindex: number | null): ClickUpTask {
  const custom_fields: Array<{ id: string; name: string; value: unknown }> = [
    { id: 'cf-fn', name: 'Nombre de Paciente',    value: 'IlegivelUNR' },
    { id: 'cf-ln', name: 'Apellido del Paciente', value: 'Patologia QA' },
  ];
  if (orderindex !== null) custom_fields.push({ id: 'cf-pat', name: PATOLOGIA, value: orderindex });
  return {
    id: taskId,
    name: 'Patologia QA, IlegivelUNR',
    parent: null,
    status: { status: 'admisión' },
    custom_fields,
  } as unknown as ClickUpTask;
}

describe('UNR — opção ILEGÍVEL de "Tipo de Patología" fica em LISTA, sem o valor @integration', () => {
  let pool: Pool;
  let terminology: IcdCatalogTerminology;
  let patientId = '';

  const rejeicoes = async () =>
    (await pool.query<{ linha: Record<string, unknown> }>(
      `SELECT to_jsonb(t) AS linha FROM patient_source_label_rejections t
        WHERE patient_id = $1 ORDER BY reason`,
      [patientId],
    )).rows.map(r => r.linha);

  function makeUseCase(): SyncPatientFromClickUpTaskUseCase {
    const diagnosisMapper = new ClickUpDiagnosisMapper(
      new ClickUpDiagnosisLabelRepository(),
      new ClickUpDiagnosisRejectionRepository(),
      new PatientDiagnosisService(terminology, new PostgresPatientDiagnosisRepository(DiagnosisSource.CLICKUP)),
    );
    const patientService = {
      upsertFromClickUp: jest.fn(async () => ({ id: patientId, created: false, flagged: false })),
    } as unknown as PatientService;
    const noop = {
      replaceForField:   jest.fn(async () => ({ outcome: 'skipped-unreadable' as const, received: 0, empty: 0, accepted: [], rejected: [], newlyRejected: 0, rejectionsDurable: 'not-applicable' as const })),
      replaceForPatient: jest.fn(async () => ({ outcome: 'written' as const, received: 0, accepted: [], rejected: [], quarantined: 0 })),
    };
    const deps: SyncPatientDeps = {
      mapper:                new ClickUpPatientMapper(resolverFalso()),
      patientService,
      sourceLabelRepository: noop as unknown as SyncPatientDeps['sourceLabelRepository'],
      insuranceRepository:   noop as unknown as SyncPatientDeps['insuranceRepository'],
      deviceTypeRepository:  noop as unknown as SyncPatientDeps['deviceTypeRepository'],
      diagnosisMapper,
    };
    return new SyncPatientFromClickUpTaskUseCase(deps);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
    terminology = new IcdCatalogTerminology();
    // O log de erro deste caminho é ESPERADO (é a metade que a I3 já entregou) — silenciado
    // para não poluir a saída do runner. O que se afirma aqui é a LINHA, não o log.
    jest.spyOn(require('firebase-functions').logger, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
    const { rows: [p] } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'IlegivelUNR', 'Patologia QA', 'AR', 'ACTIVE') RETURNING id`,
      [`${TASK_PREFIX}${Math.random().toString(36).slice(2)}`],
    );
    patientId = p.id;
  });

  it('ILEGÍVEL: EXISTE linha de rejeição — e ela não carrega o orderindex nem rótulo algum', async () => {
    await makeUseCase().execute(tarefa(`${TASK_PREFIX}ilegivel`, IDX_ILEGIVEL), {}, 'unr-1');

    const linhas = await rejeicoes();

    // ── O CORAÇÃO DO DEFEITO: hoje esta lista vem VAZIA ──────────────────────
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      field_name:  PATOLOGIA,
      reason:      'unreadable',
      raw_label:   null,
      source:      'clickup',
      occurrences: 1,
    });

    // O VALOR não entrou: nem o orderindex, nem nenhum rótulo vivo do campo.
    const serializada = JSON.stringify(linhas[0]);
    expect(serializada).not.toContain(String(IDX_ILEGIVEL));
    for (const rotulo of Object.values(OPCOES)) expect(serializada).not.toContain(rotulo);

    // Nada foi gravado nem apagado em `patient_diagnoses` (D167/F41).
    const { rows: diag } = await pool.query(
      `SELECT 1 FROM patient_diagnoses WHERE patient_id = $1`, [patientId],
    );
    expect(diag).toHaveLength(0);

    // Re-sync do MESMO ilegível: incrementa `occurrences`, não duplica linha (304, defeito 8).
    await makeUseCase().execute(tarefa(`${TASK_PREFIX}ilegivel`, IDX_ILEGIVEL), {}, 'unr-1b');
    const linhas2 = await rejeicoes();
    expect(linhas2).toHaveLength(1);
    expect(linhas2[0]).toMatchObject({ reason: 'unreadable', raw_label: null, occurrences: 2 });
  });

  it('CONTROLE POSITIVO: rótulo que EXISTE e não está no mapa continua gravando `raw_label`', async () => {
    await makeUseCase().execute(tarefa(`${TASK_PREFIX}nao-mapeado`, IDX_NAO_MAPEADO), {}, 'unr-2');

    const linhas = await rejeicoes();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      field_name: PATOLOGIA,
      reason:     'unmapped',
      raw_label:  LABEL_NAO_MAPEADO,
    });
  });

  it('CONTROLE NEGATIVO: campo genuinamente VAZIO não gera linha (ausência legítima, D167)', async () => {
    await makeUseCase().execute(tarefa(`${TASK_PREFIX}vazio`, null), {}, 'unr-3');

    expect(await rejeicoes()).toHaveLength(0);
  });

  it('CONTROLE POSITIVO 2: opção MAPEADA continua gravando o diagnóstico e não gera rejeição', async () => {
    await makeUseCase().execute(tarefa(`${TASK_PREFIX}mapeado`, IDX_MAPEADO), {}, 'unr-4');

    expect(await rejeicoes()).toHaveLength(0);
    const { rows: diag } = await pool.query<{ concept_code: string }>(
      `SELECT concept_code FROM patient_diagnoses WHERE patient_id = $1 AND source = 'CLICKUP'`,
      [patientId],
    );
    expect(diag).toHaveLength(1);
  });
});
