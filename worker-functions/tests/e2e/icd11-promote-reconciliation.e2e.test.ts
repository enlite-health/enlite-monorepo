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

  it('tabela patient_diagnoses AINDA NÃO EXISTE (é F2) — a consulta é CONDICIONAL e não quebra', async () => {
    const regclass = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass('public.patient_diagnoses')::text AS reg`,
    );
    expect(regclass.rows[0]?.reg).toBeNull(); // pré-condição do teste: tabela realmente ausente

    const reconciliation = await promote(pool, RELEASE_OLD, 'test-c2-back'); // promove de volta, gera reconciliação de novo
    expect(reconciliation.patientDiagnosesTableExists).toBe(false);
    expect(reconciliation.affectedPatientCount).toBeNull(); // "não verificado", nunca 0 (0 mentiria "verificado e limpo")
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
