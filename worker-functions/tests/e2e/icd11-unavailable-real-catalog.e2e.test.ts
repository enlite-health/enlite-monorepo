/**
 * F1-CORREÇÃO D3 (spec 016) — os TRÊS estados de "catálogo indisponível" que o adaptador real
 * (`IcdCatalogTerminology`) tem que distinguir de "busca sem resultado", contra o Postgres de
 * verdade (sem mock): schema/tabela ausente, catálogo vazio (nunca ingerido), e ingerido mas
 * sem nenhum release marcado corrente. Nos três, US-4 exige `TerminologyUnavailableError` —
 * nunca `[]`/`null` silencioso.
 *
 * 🔴 Este arquivo MEXE NO SCHEMA `terminology` inteiro (DROP + recria via migration 323) —
 * only dado sintético/de catálogo público da OMS, nunca PHI, e o `afterAll` RESTAURA o baseline
 * (re-ingesta o release 2026-01 completo) para não deixar o ambiente pior para os outros
 * arquivos de teste desta mesma suíte. `maxWorkers: 1` no jest.config.e2e.js garante que nenhum
 * outro arquivo roda em paralelo enquanto o schema está fora do ar.
 */
import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { IcdCatalogTerminology } from '../../src/modules/terminology/infrastructure/IcdCatalogTerminology';
import { TerminologyUnavailableError } from '../../src/modules/terminology/domain/UnavailableTerminology';
import { upsertEntities, main as ingestMain } from '../../scripts/ingest-icd11-catalog';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
/**
 * 🔧 F5-CORREÇÃO T2 (QA-caça, 05/09/2026) — este arquivo recriava o schema com a 323 SOZINHA e
 * deixava o ambiente SEM a coluna gerada `concept_key` (migration 328). Efeito medido: todo
 * arquivo de e2e que rodasse DEPOIS deste quebrava com
 * `column new_e.concept_key does not exist` — inclusive a reconciliação de `--promote`. O
 * `afterAll` conferia 35.692 linhas e dava por restaurado: contagem de LINHAS não mede FORMA.
 *
 * Regra que fica: quem recria o schema `terminology` aplica a lista INTEIRA de migrations dele,
 * na ordem — nunca só a que criou as tabelas.
 */
const MIGRATIONS_TERMINOLOGY = ['323_terminology_icd11_catalog.sql', '328_terminology_concept_key.sql'].map((f) =>
  readFileSync(join(__dirname, '../../migrations', f), 'utf-8'),
);

async function recreateTerminologySchema(pool: Pool): Promise<void> {
  for (const sql of MIGRATIONS_TERMINOLOGY) await pool.query(sql);
}
const ICD11_API_BASE = process.env.ICD11_API_BASE || 'http://localhost:8085/icd/release/11/2026-01/mms';

async function reingestBaseline(): Promise<void> {
  // Restaura o catálogo real de produção sintética (35.692 linhas, release 2026-01) crawlando
  // o container `icd-spike-es` de novo — o mesmo caminho usado por toda a evidência da F1.
  await ingestMain([], { ...process.env, DATABASE_URL, ICD11_API_BASE });
}

describe('D3 — catálogo indisponível em 3 estados distintos (Postgres real, sem mock)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    // Garante que o schema existe e o catálogo real (2026-01) está de volta, não-promovido —
    // o mesmo baseline documentado no relatório da F1 original.
    await recreateTerminologySchema(pool);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM terminology.icd_entities WHERE release = '2026-01'`);
    if (rows[0].n !== 35692) {
      await reingestBaseline();
    }
    // T2 — guarda POSITIVA de FORMA, não só de contagem: se a coluna gerada não voltou, este
    // afterAll falha ALTO aqui, em vez de deixar o próximo arquivo quebrar com 42703 e o
    // ambiente pior do que encontrou.
    const { rows: forma } = await pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema='terminology' AND table_name='icd_entities' AND column_name='concept_key'`,
    );
    if (forma[0].n !== 1) {
      throw new Error('baseline NÃO restaurado: terminology.icd_entities.concept_key ausente (migration 328)');
    }

    /**
     * 🔧 F5 (QA-caça, 05/09/2026) — o baseline DOCUMENTADO deste ambiente é
     * `2026-01 / is_current = true / 35692`, e este `afterAll` restaurava as LINHAS mas deixava o
     * catálogo NÃO PROMOVIDO (o ingestor, por decisão da F1, nunca promove sozinho). Resultado
     * medido: todo arquivo de e2e que rodasse DEPOIS deste, no mesmo `jest`, encontrava "nenhum
     * release corrente" e falhava com `TerminologyUnavailableError` — uma falha que some quando
     * o arquivo roda sozinho, que é o pior tipo. Promover de volta fecha a restauração.
     */
    await pool.query(
      `UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current`,
    );
    await pool.query(
      `UPDATE terminology.icd_releases
          SET is_current = true, promoted_at = NOW(), promoted_by = 'e2e-baseline-restore'
        WHERE release = '2026-01'`,
    );
    const { rows: corrente } = await pool.query<{ release: string }>(
      `SELECT release FROM terminology.icd_releases WHERE is_current`,
    );
    if (corrente[0]?.release !== '2026-01') {
      throw new Error('baseline NÃO restaurado: nenhum release corrente depois do afterAll');
    }
    await pool.end();
    // 🔧 F5 — o teto era 30000 ms, e a restauração inclui um CRAWL COMPLETO do container
    // (35.692 entidades). Medido isolado: ~12 s. Sob contenção de CPU (o resto da suíte e2e
    // rodando na mesma máquina) passou de 30 s, o hook ESTOUROU, e o catálogo ficou VAZIO — 8
    // suítes seguintes caíram em cascata por um ambiente que este arquivo destruiu e não
    // conseguiu reconstruir a tempo. Hook que RESTAURA ambiente não pode ter teto apertado: o
    // custo de esperar é segundos; o de estourar é a suíte inteira, e o ambiente pior do que
    // estava quando ela começou.
  }, 240000);

  it('1) schema/tabela do catálogo ausente → TerminologyUnavailableError, nunca erro cru do driver', async () => {
    await pool.query('DROP SCHEMA IF EXISTS terminology CASCADE');
    try {
      const repo = new IcdCatalogTerminology();
      await expect(repo.search('autismo')).rejects.toBeInstanceOf(TerminologyUnavailableError);
      await expect(repo.getByUri('qualquer')).rejects.toBeInstanceOf(TerminologyUnavailableError);
      await expect(repo.ancestorsOf('qualquer')).rejects.toBeInstanceOf(TerminologyUnavailableError);
    } finally {
      await recreateTerminologySchema(pool); // schema INTEIRO de volta (323 + 328) para o próximo cenário
    }
  });

  it('2) schema existe mas catálogo vazio (nunca ingerido) → TerminologyUnavailableError, nunca []', async () => {
    // Migration já rodou no teste anterior (finally) — tabelas existem e estão vazias.
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM terminology.icd_releases`);
    expect(rows[0].n).toBe(0); // premissa do cenário: catálogo REALMENTE vazio

    const repo = new IcdCatalogTerminology();
    await expect(repo.search('autismo')).rejects.toBeInstanceOf(TerminologyUnavailableError);
  });

  it('3) ingerido mas NENHUM release corrente (nunca promovido) → TerminologyUnavailableError, nunca []', async () => {
    await upsertEntities(pool, 'TEST-D3-INGERIDO', [
      {
        icdUri: 'http://id.who.int/icd/release/11/test-d3/mms/1',
        code: '99F0',
        titleEs: 'Diagnóstico de prueba ingerido, sem release corrente',
        titleEn: null,
        chapter: '99',
        parentUri: null,
        kind: 'stem',
        isLeaf: true,
      },
    ]);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM terminology.icd_releases WHERE is_current = true`);
    expect(rows[0].n).toBe(0); // premissa: ingerido, mas ninguém promoveu (ato deliberado que não aconteceu)

    const repo = new IcdCatalogTerminology();
    await expect(repo.search('diagnóstico de prueba ingerido')).rejects.toBeInstanceOf(TerminologyUnavailableError);

    // Prova positiva: PROMOVER resolve — vira busca normal, com resultado (não é catálogo
    // quebrado por acidente, é especificamente "ninguém promoveu ainda").
    await pool.query(`UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'd3-test' WHERE release = 'TEST-D3-INGERIDO'`);
    const out = await repo.search('diagnóstico de prueba ingerido');
    expect(out.map((c) => c.code.value)).toContain('99F0');

    await pool.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE release = 'TEST-D3-INGERIDO'`);
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release = 'TEST-D3-INGERIDO'`);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release = 'TEST-D3-INGERIDO'`);
  });
});
