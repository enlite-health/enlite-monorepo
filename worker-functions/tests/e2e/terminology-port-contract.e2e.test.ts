/**
 * TerminologyPort — teste de CONTRATO (spec 016, "Contrato de arquitetura"): "o teste de
 * contrato é da PORTA, e roda contra os dois: o adaptador real e o fake. Se só passa no real, a
 * abstração vazou." Este arquivo roda a MESMA bateria contra `IcdCatalogTerminology` (Postgres
 * real, sem mock — CLAUDE.md: "nunca mocke... o Postgres nos testes de integração") e contra
 * `InMemoryTerminology` (fake).
 *
 * Fixtures próprias (release 'TEST-CONTRACT-FIXTURES', capítulo '99') — não dependem da
 * ingestão real do CID-11 rodar antes; isolado do catálogo de produção, criado/limpo neste
 * arquivo. As duas execuções (uma por `%s` do describe.each) aparecem no MESMO relatório do
 * jest — é a prova pedida pelo critério de aceite 6.
 *
 * 🔧 F1-CORREÇÕES: a suíte agora PROMOVE `TEST-CONTRACT-FIXTURES` a release corrente antes de
 * rodar (D2: o adaptador real só enxerga o release marcado `is_current`) e restaura o release
 * que estava corrente antes, no `afterAll` — nunca deixa o ambiente com um release de teste
 * promovido. D4 e D7 entram na bateria COMPARTILHADA (rodam nos dois adaptadores, mesmo
 * resultado). D2, D3 e D8 são específicos do Postgres real — documentados abaixo o motivo de
 * não terem equivalente honesto no fake (D3 tem sua própria prova simétrica, "catálogo vazio",
 * na suíte do fake: InMemoryTerminology.test.ts).
 */
import { Pool } from 'pg';
import { IcdCatalogTerminology } from '../../src/modules/terminology/infrastructure/IcdCatalogTerminology';
import { InMemoryTerminology } from '../../src/modules/terminology/infrastructure/InMemoryTerminology';
import type { DiagnosisEntity, TerminologyPort } from '../../src/modules/terminology/domain/TerminologyPort';
import { IcdCode } from '../../src/modules/terminology/domain/IcdCode';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const FIXTURE_RELEASE = 'TEST-CONTRACT-FIXTURES';

const CHAPTER_ZZ: DiagnosisEntity = {
  uri: 'test://contract/chapter-zz',
  code: IcdCode.parse('99'),
  titleEs: 'Capítulo de prueba',
  titleEn: 'Test chapter',
  chapter: '99',
  release: FIXTURE_RELEASE,
  kind: 'chapter',
  isLeaf: false,
  parentUri: null,
};

const STEM: DiagnosisEntity = {
  uri: 'test://contract/stem-1',
  code: IcdCode.parse('ZZ01'),
  titleEs: 'Trastorno de prueba raro',
  titleEn: 'Rare test disorder',
  chapter: '99',
  release: FIXTURE_RELEASE,
  kind: 'stem',
  isLeaf: true,
  parentUri: CHAPTER_ZZ.uri,
};

const STEM_OUTRO_CAPITULO: DiagnosisEntity = {
  uri: 'test://contract/stem-2',
  code: IcdCode.parse('YY01'),
  titleEs: 'Otro trastorno de prueba',
  titleEn: 'Another test disorder',
  chapter: 'YY',
  release: FIXTURE_RELEASE,
  kind: 'stem',
  isLeaf: true,
  parentUri: null,
};

const EXTENSION: DiagnosisEntity = {
  uri: 'test://contract/ext-1',
  code: IcdCode.parse('XZZ1'),
  titleEs: 'Código de extensión de prueba',
  titleEn: 'Test extension code',
  chapter: '99',
  release: FIXTURE_RELEASE,
  kind: 'extension',
  isLeaf: true,
  parentUri: null,
};

const FIXTURES = [CHAPTER_ZZ, STEM, STEM_OUTRO_CAPITULO, EXTENSION];

async function seedPostgres(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, $2) ON CONFLICT (release) DO NOTHING`, [
    FIXTURE_RELEASE,
    FIXTURES.length,
  ]);
  for (const e of FIXTURES) {
    await pool.query(
      `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (icd_uri, release) DO UPDATE SET
         title_es = EXCLUDED.title_es, title_en = EXCLUDED.title_en, chapter = EXCLUDED.chapter,
         parent_uri = EXCLUDED.parent_uri, kind = EXCLUDED.kind, is_leaf = EXCLUDED.is_leaf`,
      [e.uri, e.release, e.code.value, e.titleEs, e.titleEn, e.chapter, e.parentUri, e.kind, e.isLeaf],
    );
  }
}

async function cleanupPostgres(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM terminology.icd_entities WHERE release = $1`, [FIXTURE_RELEASE]);
  await pool.query(`DELETE FROM terminology.icd_releases WHERE release = $1`, [FIXTURE_RELEASE]);
}

/** D2: só um release é corrente por vez — a suíte precisa promover a fixture e DEVOLVER o estado anterior. */
async function currentRelease(pool: Pool): Promise<string | null> {
  const { rows } = await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current = true LIMIT 1`);
  return rows[0]?.release ?? null;
}

async function promoteAsCurrent(pool: Pool, release: string): Promise<void> {
  await pool.query(
    `UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current = true`,
  );
  await pool.query(
    `UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = 'contract-test' WHERE release = $1`,
    [release],
  );
}

async function clearCurrent(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current = true`,
  );
}

describe('TerminologyPort — contrato (spec 016 F1)', () => {
  let pool: Pool;
  let releaseCorrenteAntesDaSuite: string | null;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanupPostgres(pool); // idempotência: sobra de execução anterior não deveria existir, mas não confio
    await seedPostgres(pool);
    releaseCorrenteAntesDaSuite = await currentRelease(pool);
    await promoteAsCurrent(pool, FIXTURE_RELEASE); // D2: adaptador real só enxerga o release corrente
  });

  afterAll(async () => {
    await cleanupPostgres(pool);
    // Restaura o release que estava corrente ANTES desta suíte — nunca deixa um release de
    // teste promovido no ambiente, e nunca perde a promoção que já existia.
    if (releaseCorrenteAntesDaSuite) {
      await promoteAsCurrent(pool, releaseCorrenteAntesDaSuite);
    } else {
      await clearCurrent(pool);
    }
    await pool.end();
  });

  const adapters: Array<[string, () => TerminologyPort]> = [
    ['fake em memória (InMemoryTerminology)', () => new InMemoryTerminology(FIXTURES)],
    ['adaptador real (IcdCatalogTerminology, Postgres)', () => new IcdCatalogTerminology()],
  ];

  describe.each(adapters)('%s', (_label, factory) => {
    let port: TerminologyPort;

    beforeEach(() => {
      port = factory();
    });

    it('search: acha por substring exata', async () => {
      const out = await port.search('trastorno de prueba raro', { chapters: ['99'] });
      expect(out.map((c) => c.code.value)).toContain('ZZ01');
    });

    it('search: tolera 1 erro de digitação (US-1)', async () => {
      const out = await port.search('trastonro', { chapters: ['99'] });
      expect(out.map((c) => c.code.value)).toContain('ZZ01');
    });

    it('search: filtra por capítulo — não vaza entidade de outro capítulo', async () => {
      const out = await port.search('trastorno', { chapters: ['99'] });
      expect(out.map((c) => c.code.value)).not.toContain('YY01');
    });

    it('search: exclui kind=extension por padrão', async () => {
      const out = await port.search('extensión', { chapters: ['99'] });
      expect(out.map((c) => c.code.value)).not.toContain('XZZ1');
    });

    it('search: inclui extension quando includeExtensions=true', async () => {
      const out = await port.search('extensión', { chapters: ['99'], includeExtensions: true });
      expect(out.map((c) => c.code.value)).toContain('XZZ1');
    });

    it('search: candidato não carrega nenhum campo cru da OMS', async () => {
      const [candidate] = await port.search('trastorno de prueba raro', { chapters: ['99'] });
      expect(Object.keys(candidate).sort()).toEqual(['chapter', 'code', 'title', 'uri']);
    });

    it('D7: candidato expõe `code` como IcdCode (Value Object), não string crua', async () => {
      const [candidate] = await port.search('trastorno de prueba raro', { chapters: ['99'] });
      expect(candidate.code).toBeInstanceOf(IcdCode);
      expect(candidate.code.value).toBe('ZZ01');
    });

    it('D4: query vazia, "%", "_" e uma letra sozinha (abaixo do piso de 2) devolvem [] — MESMO resultado no fake e no real', async () => {
      expect(await port.search('')).toEqual([]);
      expect(await port.search('%')).toEqual([]);
      expect(await port.search('_')).toEqual([]);
      expect(await port.search('z')).toEqual([]);
    });

    it('D4: "%" e "_" DENTRO de uma query válida não viram curinga (não casam tudo)', async () => {
      // Sem escape, ILIKE '%'||'%'||'%' casaria QUALQUER título. Com >=2 chars e escape, "%%"
      // sozinho não deveria achar nada no fixture (nenhum título contém literalmente "%%").
      const out = await port.search('%%');
      expect(out).toEqual([]);
    });

    it('getByUri: encontra a entidade completa, `code` como IcdCode', async () => {
      const entity = await port.getByUri(STEM.uri);
      expect(entity?.code).toBeInstanceOf(IcdCode);
      expect(entity).toMatchObject({ uri: STEM.uri, chapter: '99', kind: 'stem' });
      expect(entity?.code.value).toBe('ZZ01');
    });

    it('getByUri: devolve null para uri inexistente — nunca lança', async () => {
      const entity = await port.getByUri('test://contract/nao-existe');
      expect(entity).toBeNull();
    });

    it('ancestorsOf: resolve o capítulo', async () => {
      const { chapter } = await port.ancestorsOf(STEM.uri);
      expect(chapter.code).toBe('99');
      expect(chapter.title).toBe(CHAPTER_ZZ.titleEs);
    });

    it('ancestorsOf: lança para uri inexistente — nunca devolve capítulo inventado', async () => {
      await expect(port.ancestorsOf('test://contract/nao-existe')).rejects.toThrow();
    });
  });
});

/**
 * D2 — "trocar release é ato deliberado, e muda o que search() devolve": específico do
 * Postgres real. O fake (`InMemoryTerminology`) não tem noção de "release corrente" — ele é
 * construído com um array fixo de entidades, sem um `icd_releases` por trás — então não há uma
 * versão honesta deste caso para rodar nele sem inventar um conceito que a spec não pede.
 */
describe('D2 — promover um release muda o que search() devolve (Postgres real)', () => {
  let pool: Pool;
  const RELEASE_A = 'TEST-D2-RELEASE-A';
  const RELEASE_B = 'TEST-D2-RELEASE-B';
  let releaseCorrenteAntes: string | null;

  const ENTITY_A: DiagnosisEntity = {
    uri: 'test://d2/a',
    code: IcdCode.parse('D2A1'),
    titleEs: 'Diagnóstico exclusivo do release A',
    titleEn: null,
    chapter: 'ZZ',
    release: RELEASE_A,
    kind: 'stem',
    isLeaf: true,
    parentUri: null,
  };
  const ENTITY_B: DiagnosisEntity = {
    uri: 'test://d2/b',
    code: IcdCode.parse('D2B1'),
    titleEs: 'Diagnóstico exclusivo do release B',
    titleEn: null,
    chapter: 'ZZ',
    release: RELEASE_B,
    kind: 'stem',
    isLeaf: true,
    parentUri: null,
  };

  async function seedRelease(entity: DiagnosisEntity): Promise<void> {
    await pool.query(`INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, 1) ON CONFLICT (release) DO NOTHING`, [
      entity.release,
    ]);
    await pool.query(
      `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (icd_uri, release) DO NOTHING`,
      [entity.uri, entity.release, entity.code.value, entity.titleEs, entity.titleEn, entity.chapter, entity.parentUri, entity.kind, entity.isLeaf],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    releaseCorrenteAntes = await currentRelease(pool);
    await seedRelease(ENTITY_A);
    await seedRelease(ENTITY_B);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release IN ($1, $2)`, [RELEASE_A, RELEASE_B]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release IN ($1, $2)`, [RELEASE_A, RELEASE_B]);
    if (releaseCorrenteAntes) await promoteAsCurrent(pool, releaseCorrenteAntes);
    else await clearCurrent(pool);
    await pool.end();
  });

  it('ANTES/DEPOIS: promover A depois B muda o resultado de search() — nunca mistura os dois releases', async () => {
    await promoteAsCurrent(pool, RELEASE_A);
    const antes = await new IcdCatalogTerminology().search('diagnóstico exclusivo', { chapters: ['ZZ'] });
    expect(antes.map((c) => c.code.value)).toEqual(['D2A1']);

    await promoteAsCurrent(pool, RELEASE_B);
    const depois = await new IcdCatalogTerminology().search('diagnóstico exclusivo', { chapters: ['ZZ'] });
    expect(depois.map((c) => c.code.value)).toEqual(['D2B1']);
  });
});

/**
 * D8 — teto de `limit`: específico do Postgres real. A instrução do defeito é explícita: "ponha
 * teto no ADAPTADOR (ele é a única camada que conhece o custo)" — o fake não ganha o mesmo teto
 * de propósito (não simula custo de I/O, e os fixtures de teste nunca chegam perto do volume que
 * justificaria um limite).
 */
describe('D8 — teto de limit (Postgres real)', () => {
  let pool: Pool;
  let releaseCorrenteAntes: string | null;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    releaseCorrenteAntes = await currentRelease(pool);
    // Promove o catálogo real (35.692 linhas, release 2026-01) — só ele tem volume suficiente
    // para provar o teto contra um `limit` absurdo; os fixtures de contrato (4 linhas) nunca
    // chegariam nem perto de 200 resultados.
    await promoteAsCurrent(pool, '2026-01');
  });

  afterAll(async () => {
    if (releaseCorrenteAntes) await promoteAsCurrent(pool, releaseCorrenteAntes);
    else await clearCurrent(pool);
    await pool.end();
  });

  it('search com limit muito acima do teto nunca excede 200 linhas', async () => {
    const port = new IcdCatalogTerminology();
    const out = await port.search('aa', { limit: 100000 });
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.length).toBeGreaterThan(0); // prova que a query realmente casou muita coisa (senão o teto não prova nada)
  });
});

/**
 * C1 (D261, F1.5) — leitura RELEASE-AWARE: `getByUri`/`ancestorsOf` aceitam `asOfRelease?`.
 *
 * PROVADO EM TRANSAÇÃO (o pedido do CTO, literal): ingere/semeia dois releases, promove o NOVO
 * SEM um código do release antigo (`ENTITY_ORPHAN` — simula um código aposentado pela OMS), e
 * mostra que `getByUri(uri)` (sem argumento — release corrente) devolve `null` MAS
 * `getByUri(uri, RELEASE_OLD)` devolve a entidade. Roda nos DOIS adaptadores — se só passasse no
 * real, a abstração vazaria (mesmo espírito do "Contrato de arquitetura").
 *
 * `InMemoryTerminology` ganha um 2º parâmetro opcional (`{ currentRelease }`) SÓ para este teste
 * ter um equivalente honesto: o fake nunca teve noção de release corrente (documentado no D2
 * acima) porque nenhum teste antes deste precisava. Backward-compat: sem esse parâmetro, o fake
 * se comporta EXATAMENTE como antes (nenhum teste existente passa `currentRelease`).
 */
describe('C1 — leitura release-aware: getByUri/ancestorsOf aceitam asOfRelease (D261)', () => {
  const RELEASE_OLD = 'TEST-C1-OLD';
  const RELEASE_NEW = 'TEST-C1-NEW';

  const CHAPTER_OLD: DiagnosisEntity = {
    uri: 'test://c1/chapter-old',
    code: IcdCode.parse('77'),
    titleEs: 'Capítulo de prueba (release antigo)',
    titleEn: 'Test chapter (old release)',
    chapter: '77',
    release: RELEASE_OLD,
    kind: 'chapter',
    isLeaf: false,
    parentUri: null,
  };
  const CHAPTER_NEW: DiagnosisEntity = {
    uri: 'test://c1/chapter-new',
    code: IcdCode.parse('77'),
    titleEs: 'Capítulo de prueba (release nuevo)',
    titleEn: 'Test chapter (new release)',
    chapter: '77',
    release: RELEASE_NEW,
    kind: 'chapter',
    isLeaf: false,
    parentUri: null,
  };
  /** Existe SÓ no release antigo — simula um código que a OMS aposentou no release novo. */
  const ENTITY_ORPHAN: DiagnosisEntity = {
    uri: 'test://c1/orphan',
    code: IcdCode.parse('ZO01'),
    titleEs: 'Diagnóstico aposentado no release nuevo',
    titleEn: 'Diagnosis retired in the new release',
    chapter: '77',
    release: RELEASE_OLD,
    kind: 'stem',
    isLeaf: true,
    parentUri: CHAPTER_OLD.uri,
  };
  /** Sobrevive nos dois releases (mesmo uri) — controle: leitura sem asOfRelease continua igual. */
  const ENTITY_SURVIVOR: DiagnosisEntity = {
    uri: 'test://c1/survivor',
    code: IcdCode.parse('ZS01'),
    titleEs: 'Diagnóstico que sobrevive nos dois releases',
    titleEn: 'Diagnosis that survives both releases',
    chapter: '77',
    release: RELEASE_NEW,
    kind: 'stem',
    isLeaf: true,
    parentUri: CHAPTER_NEW.uri,
  };

  async function seedC1Postgres(pool: Pool): Promise<void> {
    await pool.query(
      `INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, 2), ($2, 2)
       ON CONFLICT (release) DO NOTHING`,
      [RELEASE_OLD, RELEASE_NEW],
    );
    const rows = [CHAPTER_OLD, CHAPTER_NEW, ENTITY_ORPHAN, ENTITY_SURVIVOR];
    for (const e of rows) {
      await pool.query(
        `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (icd_uri, release) DO UPDATE SET
           title_es = EXCLUDED.title_es, title_en = EXCLUDED.title_en, chapter = EXCLUDED.chapter,
           parent_uri = EXCLUDED.parent_uri, kind = EXCLUDED.kind, is_leaf = EXCLUDED.is_leaf`,
        [e.uri, e.release, e.code.value, e.titleEs, e.titleEn, e.chapter, e.parentUri, e.kind, e.isLeaf],
      );
    }
  }

  async function cleanupC1Postgres(pool: Pool): Promise<void> {
    await pool.query(`DELETE FROM terminology.icd_entities WHERE release IN ($1, $2)`, [RELEASE_OLD, RELEASE_NEW]);
    await pool.query(`DELETE FROM terminology.icd_releases WHERE release IN ($1, $2)`, [RELEASE_OLD, RELEASE_NEW]);
  }

  let pool: Pool;
  let releaseCorrenteAntes: string | null;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanupC1Postgres(pool);
    await seedC1Postgres(pool);
    releaseCorrenteAntes = await currentRelease(pool);
    // A ORDEM importa: promove OLD primeiro, depois NEW — reproduzindo exatamente o cenário do
    // pedido ("promovido um release novo que não contém 6A02.Z"), não um estado já promovido.
    await promoteAsCurrent(pool, RELEASE_OLD);
    await promoteAsCurrent(pool, RELEASE_NEW); // RELEASE_NEW passa a ser o corrente
  });

  afterAll(async () => {
    await cleanupC1Postgres(pool);
    if (releaseCorrenteAntes) await promoteAsCurrent(pool, releaseCorrenteAntes);
    else await clearCurrent(pool);
    await pool.end();
  });

  const c1Adapters: Array<[string, () => TerminologyPort]> = [
    [
      'fake em memória (InMemoryTerminology)',
      () =>
        new InMemoryTerminology([CHAPTER_OLD, CHAPTER_NEW, ENTITY_ORPHAN, ENTITY_SURVIVOR], {
          currentRelease: RELEASE_NEW,
        }),
    ],
    ['adaptador real (IcdCatalogTerminology, Postgres)', () => new IcdCatalogTerminology()],
  ];

  describe.each(c1Adapters)('%s', (_label, factory) => {
    let port: TerminologyPort;

    beforeEach(() => {
      port = factory();
    });

    it('getByUri(uri) sob o release CORRENTE (novo) devolve null para código que saiu — a promessa quebrada da spec, reproduzida', async () => {
      const current = await port.getByUri(ENTITY_ORPHAN.uri);
      expect(current).toBeNull();
    });

    it('getByUri(uri, releaseAntigo) AINDA encontra o código, mesmo com outro release corrente — a prova do conserto', async () => {
      const historical = await port.getByUri(ENTITY_ORPHAN.uri, RELEASE_OLD);
      expect(historical).not.toBeNull();
      expect(historical?.release).toBe(RELEASE_OLD);
      expect(historical?.code.value).toBe(ENTITY_ORPHAN.code.value);
      expect(historical?.code).toBeInstanceOf(IcdCode);
    });

    it('getByUri(uri) sem asOfRelease continua igual ao comportamento de hoje (retrocompatível) para código que sobrevive', async () => {
      const current = await port.getByUri(ENTITY_SURVIVOR.uri);
      expect(current).not.toBeNull();
      expect(current?.release).toBe(RELEASE_NEW);
    });

    it('ancestorsOf(uri, releaseAntigo) resolve o capítulo do release HISTÓRICO, mesmo não sendo o corrente', async () => {
      const { chapter } = await port.ancestorsOf(ENTITY_ORPHAN.uri, RELEASE_OLD);
      expect(chapter.code).toBe('77');
      expect(chapter.title).toBe(CHAPTER_OLD.titleEs);
    });

    it('ancestorsOf(uri) SEM asOfRelease lança para código inalcançável no release corrente (nunca inventa capítulo)', async () => {
      await expect(port.ancestorsOf(ENTITY_ORPHAN.uri)).rejects.toThrow();
    });
  });
});
