/**
 * F1-CORREÇÕES D1 e D5 (spec 016) — a camada de PERSISTÊNCIA do ingestor
 * (`scripts/ingest-icd11-catalog.ts`), contra o Postgres real. Sem HTTP: chama `upsertEntities`
 * diretamente com entidades sintéticas — o crawl (`crawlTree`/`fillEnglishTitles`) já é coberto
 * pelos testes de `rewrite-host`/`classify-entity` e pela ingestão real documentada no
 * relatório; aqui o alvo é só "o que acontece quando duas rodadas de gravação colidem".
 *
 * D1 — identidade da linha é (icd_uri, release): dois releases com o MESMO icd_uri coexistem
 * sem um sobrescrever o outro por baixo (o cenário exato que produziu o release "fantasma" —
 * `--release` declarado divergente do que foi de fato crawlado, ver D10).
 * D5 — a gravação de um release inteiro é transacional: uma falha no meio do batch de
 * entidades deixa ZERO linhas do release novo (rollback completo), e não toca o que já existia
 * de outro release. `entity_count` é a contagem REAL pós-carga, não o tamanho do array de
 * entrada.
 */
import { Pool } from 'pg';
import { upsertEntities, loadStored, type CrawledEntity } from '../../scripts/ingest-icd11-catalog';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RELEASE_OLD = 'TEST-D1-2026-01';
const RELEASE_NEW = 'TEST-D1-2026-05';
const RELEASE_PARTIAL = 'TEST-D5-PARTIAL';

function entity(overrides: Partial<CrawledEntity> & { icdUri: string; code: string }): CrawledEntity {
  return {
    titleEs: 'Título de prueba',
    titleEn: 'Test title',
    chapter: '99',
    parentUri: null,
    kind: 'stem',
    isLeaf: true,
    ...overrides,
  };
}

// O MESMO icd_uri usado sob dois rótulos de release — reproduz o cenário do D1 (operador
// declarou --release errado para o que a API de fato serviu): a identidade da linha tem que
// ser o PAR (icd_uri, release), não o icd_uri sozinho, senão a 2ª gravação apaga a 1ª por baixo.
const SHARED_URI = 'http://id.who.int/icd/release/11/test-d1/mms/999999';

describe('D1 — dois releases coexistem (Postgres real, sem mock)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release IN ($1, $2)`, [RELEASE_OLD, RELEASE_NEW]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release IN ($1, $2)`, [RELEASE_OLD, RELEASE_NEW]);
    await pool.end();
  });

  it('ingerir OLD e depois NEW com o MESMO icd_uri: as duas contagens ficam corretas lado a lado', async () => {
    const countOld = await upsertEntities(pool, RELEASE_OLD, [
      entity({ icdUri: SHARED_URI, code: '99A0', titleEs: 'Versão antiga do mesmo conceito' }),
      entity({ icdUri: 'http://.../old-only', code: '99A1', titleEs: 'Só existe no release antigo' }),
    ]);
    const countNew = await upsertEntities(pool, RELEASE_NEW, [
      entity({ icdUri: SHARED_URI, code: '99B0', titleEs: 'Versão nova do mesmo conceito' }),
    ]);

    expect(countOld).toBe(2);
    expect(countNew).toBe(1);

    const { rows: releaseRows } = await pool.query<{ release: string; entity_count: number }>(
      `SELECT release, entity_count FROM terminology.icd_releases WHERE release IN ($1, $2) ORDER BY release`,
      [RELEASE_OLD, RELEASE_NEW],
    );
    expect(releaseRows).toEqual([
      { release: RELEASE_OLD, entity_count: 2 },
      { release: RELEASE_NEW, entity_count: 1 },
    ]);

    // A linha do release ANTIGO, sob o MESMO icd_uri, não foi tocada pela gravação do release NOVO.
    const oldStored = await loadStored(pool, RELEASE_OLD);
    expect(oldStored.get(SHARED_URI)?.titleEs).toBe('Versão antiga do mesmo conceito');
    expect(oldStored.get(SHARED_URI)?.code).toBe('99A0');

    const newStored = await loadStored(pool, RELEASE_NEW);
    expect(newStored.get(SHARED_URI)?.titleEs).toBe('Versão nova do mesmo conceito');
    expect(newStored.get(SHARED_URI)?.code).toBe('99B0');

    // Prova direta no banco: DUAS linhas para o mesmo icd_uri, uma por release — a composite PK
    // (icd_uri, release) é o que torna isso possível (RED: com PK só em icd_uri, a 2ª gravação
    // faria UPDATE na mesma linha e a 1ª desapareceria — ver evidencias/f1fix-D1-*.txt).
    const { rows: sharedRows } = await pool.query(
      `SELECT release, code FROM terminology.icd_entities WHERE icd_uri = $1 ORDER BY release`,
      [SHARED_URI],
    );
    expect(sharedRows).toEqual([
      { release: RELEASE_OLD, code: '99A0' },
      { release: RELEASE_NEW, code: '99B0' },
    ]);
  });
});

describe('D5 — gravação de um release é transacional (Postgres real, sem mock)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release = $1`, [RELEASE_PARTIAL]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release = $1`, [RELEASE_PARTIAL]);
    await pool.end();
  });

  it('uma entidade inválida no meio do lote (viola CHECK do banco) faz ROLLBACK: 0 linhas do release novo ficam gravadas', async () => {
    const entidadeInvalida = entity({
      icdUri: 'http://.../invalida',
      code: '   ', // viola icd_entities_code_nao_vazio (CHECK btrim(code) <> '')
    });

    await expect(
      upsertEntities(pool, RELEASE_PARTIAL, [
        entity({ icdUri: 'http://.../valida-1', code: '99C0' }),
        entity({ icdUri: 'http://.../valida-2', code: '99C1' }),
        entidadeInvalida,
        entity({ icdUri: 'http://.../valida-3', code: '99C2' }),
      ]),
    ).rejects.toThrow();

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM terminology.icd_entities WHERE release = $1`, [
      RELEASE_PARTIAL,
    ]);
    expect(rows[0].n).toBe(0); // nem as 2 válidas ANTES da inválida no lote ficaram — tudo ou nada

    const { rows: releaseRows } = await pool.query(`SELECT entity_count FROM terminology.icd_releases WHERE release = $1`, [
      RELEASE_PARTIAL,
    ]);
    expect(releaseRows).toHaveLength(0); // o próprio upsert de icd_releases também foi revertido
  });

  it('release PRÉ-EXISTENTE não é afetado quando uma ingestão de OUTRO release falha no meio', async () => {
    // Ingestão bem-sucedida primeiro, como baseline.
    await upsertEntities(pool, RELEASE_PARTIAL, [entity({ icdUri: 'http://.../baseline', code: '99D0' })]);
    const { rows: before } = await pool.query(`SELECT count(*)::int AS n FROM terminology.icd_entities WHERE release = $1`, [
      RELEASE_PARTIAL,
    ]);
    expect(before[0].n).toBe(1);

    // Uma ingestão de um release DIFERENTE que falha não pode tocar o release acima.
    await expect(
      upsertEntities(pool, RELEASE_PARTIAL + '-OUTRO', [entity({ icdUri: 'http://.../outro-invalido', code: '' })]),
    ).rejects.toThrow();

    const { rows: after } = await pool.query(`SELECT count(*)::int AS n FROM terminology.icd_entities WHERE release = $1`, [
      RELEASE_PARTIAL,
    ]);
    expect(after[0].n).toBe(1); // intacto

    await pool.query(`DELETE FROM terminology.icd_entities WHERE release = $1`, [RELEASE_PARTIAL + '-OUTRO']);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release = $1`, [RELEASE_PARTIAL + '-OUTRO']);
  });

  it('entity_count gravado é a CONTAGEM REAL pós-carga, não o tamanho do array de entrada', async () => {
    // Re-ingestão do MESMO release (rerun do ingestor) upserta a MESMA uri de novo — a linha
    // é uma só (composite PK), então entity_count tem que continuar em 1, nunca "somar" as
    // duas chamadas como se fossem 2 entidades.
    const DUP_RELEASE = RELEASE_PARTIAL + '-DUP';
    const firstCount = await upsertEntities(pool, DUP_RELEASE, [
      entity({ icdUri: 'http://.../dup', code: '99E0', titleEs: 'Primeira versão' }),
    ]);
    expect(firstCount).toBe(1);

    const secondCount = await upsertEntities(pool, DUP_RELEASE, [
      entity({ icdUri: 'http://.../dup', code: '99E0', titleEs: 'Segunda versão (upsert, mesmo release)' }),
    ]);
    expect(secondCount).toBe(1);

    const { rows } = await pool.query(`SELECT entity_count FROM terminology.icd_releases WHERE release = $1`, [DUP_RELEASE]);
    expect(rows[0].entity_count).toBe(1);
    const stored = await loadStored(pool, DUP_RELEASE);
    expect(stored.get('http://.../dup')?.titleEs).toBe('Segunda versão (upsert, mesmo release)');

    await pool.query(`DELETE FROM terminology.icd_entities WHERE release = $1`, [DUP_RELEASE]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release = $1`, [DUP_RELEASE]);
  });
});
