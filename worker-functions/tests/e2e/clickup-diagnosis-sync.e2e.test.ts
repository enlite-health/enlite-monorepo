/**
 * clickup-diagnosis-sync.e2e.test.ts @integration — spec 016 F4
 *
 * O TESTE DE MAIOR VALOR DA FRENTE (ver prompt da fase): paciente com diagnóstico X, origem
 * PANEL, ATIVO e PRINCIPAL; roda o sync do ClickUp com payload contendo SÓ Y; assere que X
 * continua `active=true` E continua principal. É a D167 ("`null` que significa duas coisas
 * apaga dado") pela porta do ClickUp — o mesmo defeito que o gate já pegou uma vez nesta
 * branch, agora provado com os DOIS escritores reais, banco real, catálogo CID-11 real.
 *
 * Roda exatamente o caminho de produção do webhook (`ClickUpPatientWebhookController.handle`
 * → `SyncPatientFromClickUpTaskUseCase.execute` → `persistDiagnosis` →
 * `ClickUpDiagnosisMapper.syncFromLabel`), só sem o HTTP/fetch da API do ClickUp — o `task` é
 * construído em memória (o controller também recebe um `ClickUpTask` já buscado; a fronteira de
 * rede não é o que este teste teria de provar de novo).
 *
 * Entidades REAIS do catálogo 2026-01 (medidas via psql — mesmas de `patient-diagnoses-api.e2e.test.ts`):
 *   6A02.Z  "Trastorno del espectro autista, sin especificación"  (chapter 06)
 *   8D20    "Parálisis cerebral espástica"                        (chapter 08)
 * As duas têm linha em `clickup_diagnosis_labels` (migration 326, seed provisório).
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
const RUN = Date.now();
const TASK_PREFIX = `clickup-diag-e2e-${RUN}-`;

const AUTISM_CODE = '6A02.Z';
const AUTISM_URI  = 'http://id.who.int/icd/release/11/2026-01/mms/437815624/unspecified';
const PARALISIS_CODE = '8D20';
const PATOLOGIA = 'Tipo de Patología';
const LABEL_MAPEADO   = 'Parálisis Cerebral';
const LABEL_NAO_MAPEADO = `Rotulo Fantasma ${RUN}`;

/** Resolver falso: só o suficiente para o preflight de `ClickUpPatientMapper` passar e para
 *  resolver "Nombre/Apellido de Paciente" (texto, não drop_down) e "Tipo de Patología". */
function resolverDe(indexParaLabel: Record<string, number>): ClickUpFieldResolver {
  const OPCOES = [LABEL_MAPEADO];
  return {
    getFieldType: () => 'drop_down',
    resolveDropdown: (f: string, v: number | string | null | undefined) => {
      if (v === null || v === undefined || v === '') return null;
      if (f !== PATOLOGIA) return null;
      return OPCOES[Number(v)] ?? null;
    },
    resolveLabels: () => [],
    resolveLabel: () => null,
  } as unknown as ClickUpFieldResolver;
}

function taskComPatologia(clickupTaskId: string, firstName: string, lastName: string, patologiaIndex: number | null): ClickUpTask {
  const custom_fields: Array<{ id: string; name: string; value: unknown }> = [
    { id: 'cf-fn', name: 'Nombre de Paciente', value: firstName },
    { id: 'cf-ln', name: 'Apellido del Paciente', value: lastName },
  ];
  if (patologiaIndex !== null) {
    custom_fields.push({ id: 'cf-pat', name: PATOLOGIA, value: patologiaIndex });
  }
  return {
    id: clickupTaskId,
    name: `${lastName}, ${firstName}`,
    parent: null,
    status: { status: 'admisión' },
    custom_fields,
  } as unknown as ClickUpTask;
}

describe('spec 016 F4 — sync do ClickUp NÃO desativa/despromove o diagnóstico do PAINEL @integration', () => {
  let pool: Pool;
  let patientId = '';
  let terminology: IcdCatalogTerminology;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    await pool.query(
      `UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'clickup-diagnosis-sync.e2e' WHERE release = '2026-01'`,
    );
    const { rows: releaseCheck } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM terminology.icd_entities WHERE release = '2026-01'`,
    );
    if (releaseCheck[0].n < 30000) {
      throw new Error(`Catálogo real 2026-01 não está ingerido nesta base (${releaseCheck[0].n} linhas) — rode o ingestor antes deste teste.`);
    }

    terminology = new IcdCatalogTerminology();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.query(`DELETE FROM patient_source_label_rejections WHERE raw_label = $1`, [LABEL_NAO_MAPEADO]);
    await pool.end();
  });

  beforeEach(async () => {
    const { rows: [p] } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'PD', 'ClickUpDiagE2E', 'AR', 'ACTIVE') RETURNING id`,
      [`${TASK_PREFIX}${Math.random().toString(36).slice(2)}`],
    );
    patientId = p.id;
  });

  function makeDiagnosisMapper(): ClickUpDiagnosisMapper {
    return new ClickUpDiagnosisMapper(
      new ClickUpDiagnosisLabelRepository(),
      new ClickUpDiagnosisRejectionRepository(),
      new PatientDiagnosisService(terminology, new PostgresPatientDiagnosisRepository(DiagnosisSource.CLICKUP)),
    );
  }

  function makeUseCase(diagnosisMapper: ClickUpDiagnosisMapper): SyncPatientFromClickUpTaskUseCase {
    const clickupMapper = new ClickUpPatientMapper(resolverDe({}));
    const patientService = {
      upsertFromClickUp: jest.fn(async () => ({ id: patientId, created: false, flagged: false })),
    } as unknown as PatientService;
    const noop = {
      replaceForField: jest.fn(async () => ({ outcome: 'skipped-unreadable' as const, received: 0, empty: 0, accepted: [], rejected: [], newlyRejected: 0, rejectionsDurable: 'not-applicable' as const })),
      replaceForPatient: jest.fn(async () => ({ outcome: 'written' as const, received: 0, accepted: [], rejected: [], quarantined: 0 })),
    };
    const deps: SyncPatientDeps = {
      mapper: clickupMapper,
      patientService,
      sourceLabelRepository: noop as unknown as SyncPatientDeps['sourceLabelRepository'],
      insuranceRepository:   noop as unknown as SyncPatientDeps['insuranceRepository'],
      deviceTypeRepository:  noop as unknown as SyncPatientDeps['deviceTypeRepository'],
      diagnosisMapper,
    };
    return new SyncPatientFromClickUpTaskUseCase(deps);
  }

  it('CRITÉRIO 1: X (PANEL, principal) sobrevive ao sync do ClickUp que só manda Y', async () => {
    // 1. O painel grava X (autismo) como principal — o escritor humano, source=PANEL.
    const panelService = new PatientDiagnosisService(terminology, new PostgresPatientDiagnosisRepository(DiagnosisSource.PANEL));
    const created = await panelService.recordDiagnosis({ patientId, conceptUri: AUTISM_URI, isPrimary: true, actorUid: 'staff-1' });
    expect(created.outcome).toBe('created');

    // 2. O sync do ClickUp roda com uma tarefa que só manda Y (parálisis cerebral).
    const useCase = makeUseCase(makeDiagnosisMapper());
    const task = taskComPatologia(`${TASK_PREFIX}x-sobrevive`, 'PD', 'ClickUpDiagE2E', 0);
    const result = await useCase.execute(task, {}, 'cid-f4-e2e-1');
    expect(result.kind).toBe('UPDATED');

    // 3. X (PANEL) continua ATIVO e PRINCIPAL — o critério de aceite 1 da F4.
    const { rows: panelRows } = await pool.query(
      `SELECT active, is_primary, concept_code FROM patient_diagnoses WHERE patient_id = $1 AND source = 'PANEL'`,
      [patientId],
    );
    expect(panelRows).toHaveLength(1);
    expect(panelRows[0]).toMatchObject({ active: true, is_primary: true, concept_code: AUTISM_CODE });

    // 4. Y (CLICKUP) foi gravado, ATIVO e PRINCIPAL — mas na sua PRÓPRIA origem (índice
    //    parcial por (patient_id, source), migration 325).
    const { rows: clickupRows } = await pool.query(
      `SELECT active, is_primary, concept_code FROM patient_diagnoses WHERE patient_id = $1 AND source = 'CLICKUP'`,
      [patientId],
    );
    expect(clickupRows).toHaveLength(1);
    expect(clickupRows[0]).toMatchObject({ active: true, is_primary: true, concept_code: PARALISIS_CODE });
  });

  it('CRITÉRIO 2: rótulo SEM mapeamento não grava nada e fica registrado (nunca inventado)', async () => {
    const diagnosisMapper = new ClickUpDiagnosisMapper(
      new ClickUpDiagnosisLabelRepository(),
      new ClickUpDiagnosisRejectionRepository(),
      new PatientDiagnosisService(terminology, new PostgresPatientDiagnosisRepository(DiagnosisSource.CLICKUP)),
    );
    const outcome = await diagnosisMapper.syncFromLabel(patientId, LABEL_NAO_MAPEADO);
    expect(outcome).toEqual({ kind: 'unmapped' });

    const { rows: diagRows } = await pool.query(
      `SELECT * FROM patient_diagnoses WHERE patient_id = $1 AND source = 'CLICKUP'`,
      [patientId],
    );
    expect(diagRows).toHaveLength(0); // nada foi gravado

    const { rows: rejRows } = await pool.query(
      `SELECT patient_id, field_name, raw_label, reason, occurrences FROM patient_source_label_rejections
        WHERE patient_id = $1 AND raw_label = $2`,
      [patientId, LABEL_NAO_MAPEADO],
    );
    expect(rejRows).toHaveLength(1);
    expect(rejRows[0]).toMatchObject({ field_name: PATOLOGIA, reason: 'unmapped', occurrences: 1 });

    // Re-sync do MESMO rótulo desconhecido: incrementa occurrences, não duplica linha.
    await diagnosisMapper.syncFromLabel(patientId, LABEL_NAO_MAPEADO);
    const { rows: rejRows2 } = await pool.query(
      `SELECT occurrences FROM patient_source_label_rejections WHERE patient_id = $1 AND raw_label = $2`,
      [patientId, LABEL_NAO_MAPEADO],
    );
    expect(rejRows2).toHaveLength(1);
    expect(rejRows2[0].occurrences).toBe(2);
  });

  it('CRITÉRIO 3: grep — nenhum `if` de origem no mapper nem no repositório (escopo é por construtor)', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const arquivos = [
      path.join(__dirname, '../../src/modules/diagnosis/infrastructure/clickup/ClickUpDiagnosisMapper.ts'),
      path.join(__dirname, '../../src/modules/diagnosis/infrastructure/PostgresPatientDiagnosisRepository.ts'),
    ];
    for (const arq of arquivos) {
      const fonte = fs.readFileSync(arq, 'utf-8');
      const semComentario = fonte.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
      const ocorrencias = semComentario.match(/if\s*\([^)]*(?:source|CLICKUP)[^)]*\)/gi) ?? [];
      expect(ocorrencias).toEqual([]);
    }
  });
});
