/**
 * F1.5-CORREÇÃO C2 (D261, parecer do CTO) — `--promote` sem reconciliação.
 *
 * Antes desta correção, promover um release novo não dizia a ninguém que pacientes ficaram
 * órfãos: o catálogo detecta que um `icd_uri` SAIU do release novo, mas nada contava/reportava
 * isso. Conserto mínimo: `promote()` emite reconciliação POR CONTAGEM — quantas entidades do
 * release anterior não existem no novo (por `icd_uri`), e — SE a tabela `patient_diagnoses` já
 * existir (ela é F2, ainda não existe nesta fase) — quantos pacientes apontam para elas.
 *
 * 🔴 CONTAGEM APENAS: este teste também prova que `promote()` nunca imprime `icd_code`/
 * `icd_title`/texto clínico no stdout — só números (`governanca/classificacao-de-dados`).
 *
 * Postgres real, sem mock (CLAUDE.md do projeto).
 */
import { Pool } from 'pg';
import { promote, upsertEntities, type CrawledEntity } from '../../scripts/ingest-icd11-catalog';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RELEASE_OLD = 'TEST-C2-OLD';
const RELEASE_NEW = 'TEST-C2-NEW';
/** Texto propositalmente "farejável" — se aparecer cru no stdout, o teste pega. */
const ORPHAN_TITLE = 'TITULO-CLINICO-QUE-NUNCA-PODE-APARECER-NO-STDOUT';

function entity(overrides: Partial<CrawledEntity> & { icdUri: string; code: string }): CrawledEntity {
  return {
    titleEs: 'Título de prueba',
    titleEn: 'Test title',
    chapter: '88',
    parentUri: null,
    kind: 'stem',
    isLeaf: true,
    ...overrides,
  };
}

const ENTITY_SURVIVOR_URI = 'http://id.who.int/icd/release/11/test-c2/mms/survivor';
const ENTITY_ORPHAN_A_URI = 'http://id.who.int/icd/release/11/test-c2/mms/orphan-a';
const ENTITY_ORPHAN_B_URI = 'http://id.who.int/icd/release/11/test-c2/mms/orphan-b';

describe('C2 — --promote emite reconciliação por CONTAGEM (D261)', () => {
  let pool: Pool;
  let releaseCorrenteAntes: string | null;
  let logSpy: jest.SpyInstance;
  let loggedLines: string[];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();

    const { rows } = await pool.query<{ release: string }>(
      `SELECT release FROM terminology.icd_releases WHERE is_current = true LIMIT 1`,
    );
    releaseCorrenteAntes = rows[0]?.release ?? null;

    // RELEASE_OLD: sobrevivente + 2 órfãos (um deles carrega o texto farejável).
    await upsertEntities(pool, RELEASE_OLD, [
      entity({ icdUri: ENTITY_SURVIVOR_URI, code: 'ZS01' }),
      entity({ icdUri: ENTITY_ORPHAN_A_URI, code: 'ZO01', titleEs: ORPHAN_TITLE, titleEn: ORPHAN_TITLE }),
      entity({ icdUri: ENTITY_ORPHAN_B_URI, code: 'ZO02' }),
    ]);
    // RELEASE_NEW: só o sobrevivente — os dois órfãos "saíram" (aposentados pela OMS).
    await upsertEntities(pool, RELEASE_NEW, [entity({ icdUri: ENTITY_SURVIVOR_URI, code: 'ZS01' })]);

    await promote(pool, RELEASE_OLD, 'test-setup'); // RELEASE_OLD vira corrente PRIMEIRO
  });

  afterAll(async () => {
    await cleanup();
    await pool.query(`DELETE FROM clickup_diagnosis_labels WHERE label LIKE 'T2D-%'`);
    await pool.query(`DELETE FROM patient_diagnoses WHERE created_by = 'T2D'`);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'T2D-%'`);
    if (releaseCorrenteAntes) {
      await pool.query(
        `UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current = true`,
      );
      await pool.query(
        `UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'test-restore' WHERE release = $1`,
        [releaseCorrenteAntes],
      );
    }
    await pool.end();
  });

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release IN ($1, $2)`, [RELEASE_OLD, RELEASE_NEW]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release IN ($1, $2)`, [RELEASE_OLD, RELEASE_NEW]);
  }


  /** Paciente + diagnóstico ATIVO apontando para um conceito que o release novo não tem. */
  async function seedPacienteComDiagnosticoOrfao(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('T2D-promote-recon', 'T2D', 'Reconciliacion QA', 'AR', 'ACTIVE') RETURNING id`,
    );
    const patientId = rows[0].id;
    await pool.query(
      `INSERT INTO patient_diagnoses
         (patient_id, terminology_system, concept_uri, concept_code, concept_title, concept_language,
          concept_group, catalog_release, source, is_primary, created_by, updated_by)
       VALUES ($1, 'ICD-11', $2, 'ZO01', 'T2D titulo sintetico', 'es', '88', $3, 'PANEL', true, 'T2D', 'T2D')`,
      [patientId, ENTITY_ORPHAN_A_URI, RELEASE_OLD],
    );
    return patientId;
  }

  beforeEach(() => {
    loggedLines = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      loggedLines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('promover RELEASE_NEW (sem os 2 códigos antigos) reporta orphanedEntityCount=2 e previousRelease=RELEASE_OLD', async () => {
    const reconciliation = await promote(pool, RELEASE_NEW, 'test-c2');

    expect(reconciliation.previousRelease).toBe(RELEASE_OLD);
    expect(reconciliation.newRelease).toBe(RELEASE_NEW);
    expect(reconciliation.orphanedEntityCount).toBe(2);
  });

  /**
   * 🔧 F5-CORREÇÃO T1/T4 (QA-caça, 05/09/2026).
   *
   * A versão anterior deste teste afirmava `to_regclass('public.patient_diagnoses') === null`
   * ("é F2, ainda não existe nesta fase"). A F2 chegou e a tabela EXISTE — o teste estava
   * VERMELHO por premissa vencida, e era justamente a guarda `to_regclass` que mantinha o T1
   * (`42703 column pd.release does not exist`) DORMENTE. Agora o cenário é o real: a tabela
   * existe, tem uma linha órfã, e `--promote` tem de atravessar.
   */
  it('T1 — com patient_diagnoses EXISTINDO e com órfão, --promote atravessa (era 42703 → ROLLBACK → is_current parado)', async () => {
    const regclass = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass('public.patient_diagnoses')::text AS reg`,
    );
    expect(regclass.rows[0]?.reg).not.toBeNull(); // pré-condição REAL desta fase

    const patientId = await seedPacienteComDiagnosticoOrfao();
    try {
      const reconciliation = await promote(pool, RELEASE_NEW, 'test-t1');

      expect(reconciliation.patientDiagnosesTableExists).toBe(true);
      expect(reconciliation.affectedPatientCount).toBeGreaterThanOrEqual(1);

      // A prova de que a promoção ATRAVESSOU: is_current de fato se moveu (antes o 42703 dentro
      // da transação levava tudo no ROLLBACK e `is_current` não saía do lugar).
      const { rows } = await pool.query<{ release: string }>(
        `SELECT release FROM terminology.icd_releases WHERE is_current = true`,
      );
      expect(rows[0]?.release).toBe(RELEASE_NEW);
    } finally {
      await pool.query('DELETE FROM patient_diagnoses WHERE patient_id = $1', [patientId]);
      await pool.query('DELETE FROM patients WHERE id = $1', [patientId]);
      await promote(pool, RELEASE_OLD, 'test-t1-back');
    }
  });

  /**
   * 🔧 F5-CORREÇÃO T4 — a reconciliação NÃO olhava `clickup_diagnosis_labels`. Na prova do
   * QA-caça ela imprimiu "55 entidades ausentes" sem uma palavra sobre o mapa quebrado, que é
   * justamente o que fica MUDO em produção (log `info`, webhook 200, zero linha de rejeição).
   *
   * A contagem é auto-calibrada: mede a linha de base ANTES de semear, para não depender de
   * quantos mapeamentos reais a 327 deixou no banco.
   */
  it('T4 — a reconciliação CONTA os mapeamentos do ClickUp que deixariam de resolver', async () => {
    const base = await promote(pool, RELEASE_NEW, 'test-t4-base');
    expect(base.clickupLabelTableExists).toBe(true);
    const linhaDeBase = base.brokenClickupMappingCount!;
    await promote(pool, RELEASE_OLD, 'test-t4-back');

    await pool.query(
      `INSERT INTO clickup_diagnosis_labels (source, label, concept_uri, active) VALUES
         ('clickup', 'T2D-mapa-vivo', $1, true),
         ('clickup', 'T2D-mapa-morto', $2, true)
       ON CONFLICT (source, label) DO UPDATE SET concept_uri = EXCLUDED.concept_uri, active = true`,
      [ENTITY_SURVIVOR_URI, ENTITY_ORPHAN_A_URI],
    );
    try {
      const r = await promote(pool, RELEASE_NEW, 'test-t4');
      // Exatamente +1: o "morto" entra na conta, o "vivo" não.
      expect(r.brokenClickupMappingCount).toBe(linhaDeBase + 1);
    } finally {
      await pool.query(`DELETE FROM clickup_diagnosis_labels WHERE label LIKE 'T2D-%'`);
      await promote(pool, RELEASE_OLD, 'test-t4-back-2');
    }
  });

  it('T4 — mapeamento INATIVO não conta (aposentar um mapeamento é uma decisão, não uma avaria)', async () => {
    await pool.query(
      `INSERT INTO clickup_diagnosis_labels (source, label, concept_uri, active) VALUES ('clickup', 'T2D-mapa-morto', $1, false)
       ON CONFLICT (source, label) DO UPDATE SET concept_uri = EXCLUDED.concept_uri, active = false`,
      [ENTITY_ORPHAN_A_URI],
    );
    try {
      const comInativo = await promote(pool, RELEASE_NEW, 'test-t4-inativo');
      await promote(pool, RELEASE_OLD, 'test-t4-inativo-back');
      await pool.query(`DELETE FROM clickup_diagnosis_labels WHERE label LIKE 'T2D-%'`);
      const semNada = await promote(pool, RELEASE_NEW, 'test-t4-sem');

      expect(comInativo.brokenClickupMappingCount).toBe(semNada.brokenClickupMappingCount);
    } finally {
      await pool.query(`DELETE FROM clickup_diagnosis_labels WHERE label LIKE 'T2D-%'`);
      await promote(pool, RELEASE_OLD, 'test-t4-inativo-back-2');
    }
  });

  /**
   * 🔧 T2 — a comparação de órfão passou a ser por `concept_key`. Este teste é o CONTROLE
   * POSITIVO da correção: com URIs que carregam o release no path (as reais da OMS), comparar
   * por `icd_uri` daria "todos órfãos"; por `concept_key` dá zero.
   */
  it('T2 — URIs com o release ENCRAVADO no path não viram órfão falso (por icd_uri daria 100%)', async () => {
    const RELEASE_A = 'TEST-C2-URI-A';
    const RELEASE_B = 'TEST-C2-URI-B';
    const uriEm = (rel: string, id: string) => `http://id.who.int/icd/release/11/${rel}/mms/${id}`;
    try {
      await upsertEntities(pool, RELEASE_A, [
        entity({ icdUri: uriEm(RELEASE_A, '1'), code: 'ZU01' }),
        entity({ icdUri: uriEm(RELEASE_A, '2'), code: 'ZU02' }),
      ]);
      await upsertEntities(pool, RELEASE_B, [
        entity({ icdUri: uriEm(RELEASE_B, '1'), code: 'ZU01' }),
        entity({ icdUri: uriEm(RELEASE_B, '2'), code: 'ZU02' }),
      ]);
      await promote(pool, RELEASE_A, 'test-uri-a');
      const r = await promote(pool, RELEASE_B, 'test-uri-b');

      // Os 2 conceitos existem nos DOIS releases — só a URI mudou. Zero órfãos.
      expect(r.orphanedEntityCount).toBe(0);

      // Controle: a comparação ANTIGA (por icd_uri) teria dito 2 de 2.
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM terminology.icd_entities old_e
          WHERE old_e.release = $1
            AND NOT EXISTS (SELECT 1 FROM terminology.icd_entities new_e
                             WHERE new_e.release = $2 AND new_e.icd_uri = old_e.icd_uri)`,
        [RELEASE_A, RELEASE_B],
      );
      expect(Number(rows[0].count)).toBe(2);
    } finally {
      await pool.query(`DELETE FROM terminology.icd_entities WHERE release IN ($1, $2)`, [RELEASE_A, RELEASE_B]);
      await pool.query(`DELETE FROM terminology.icd_releases WHERE release IN ($1, $2)`, [RELEASE_A, RELEASE_B]);
      await promote(pool, RELEASE_OLD, 'test-uri-back');
    }
  });

  it('🔴 CONTAGEM APENAS: o stdout de --promote NUNCA imprime título/código clínico — só números', async () => {
    await promote(pool, RELEASE_NEW, 'test-c2-stdout');

    const allOutput = loggedLines.join('\n');
    expect(allOutput).not.toContain(ORPHAN_TITLE);
    expect(allOutput).not.toContain('ZO01');
    expect(allOutput).not.toContain('ZO02');
    expect(allOutput).not.toContain(ENTITY_ORPHAN_A_URI);
    // A prova positiva: os NÚMEROS aparecem (senão a asserção acima passaria por o report não
    // ter rodado, não por ele ser seguro).
    expect(allOutput).toMatch(/2/);
  });
});
