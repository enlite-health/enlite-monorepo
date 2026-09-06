/**
 * ingest-icd11-catalog.ts — spec 016 F1: percorre o container local do CID-11
 * (`icd-spike-es`, ferramenta de ingestão — NUNCA vai para produção, D260) e grava
 * `terminology.icd_entities`/`icd_releases` (migration 323).
 *
 * 🔴 Reescreve o host de toda URI antes de fazer o request (`icd11-ingest/rewrite-host.ts`) —
 * a API devolve `@id`/`child[]`/`parent[]` como `http://id.who.int/...` mesmo quando servida
 * localmente; seguir isso ao pé da letra tira o crawler do perímetro (medido na F0: HTTP 401
 * da API real da OMS). O `icd_uri` GRAVADO é a forma canônica da OMS (identificador, cláusula
 * 1.2.2) — nunca um endereço que este ou qualquer outro processo de produção resolve por HTTP.
 *
 * A API só devolve título num idioma por request (`Accept-Language`) — por isso o crawl roda em
 * DUAS passadas: a 1ª (es) descobre a árvore inteira (code/classKind/child/parent/title_es); a
 * 2ª (en) só recompleta title_en para as mesmas URIs já descobertas.
 *
 * Uso:
 *   ts-node -r dotenv/config scripts/ingest-icd11-catalog.ts                 # crawla + grava
 *   ts-node -r dotenv/config scripts/ingest-icd11-catalog.ts --dry-run       # só crawla + diff
 *   ts-node -r dotenv/config scripts/ingest-icd11-catalog.ts --promote 2026-01 --by gabriel
 *
 * Não promove sozinho: sem `--promote`, o release entra/atualiza em `icd_releases` com
 * `is_current` intocado — trocar o release corrente é sempre um comando separado e deliberado.
 *
 * 🔧 F1-CORREÇÕES (03/09, relatorio-f1-correcoes.md):
 * - D1: `upsertEntities` faz `ON CONFLICT (icd_uri, release)` — a identidade da linha é o PAR,
 *   não `icd_uri` sozinho (migration 323 atualizada). Ingerir um release novo NUNCA sobrescreve
 *   um release existente por baixo.
 * - D5: a gravação do release inteiro (upsert de `icd_releases` + todos os batches de entidade +
 *   contagem final) roda em UMA transação; `entity_count` é a contagem REAL pós-carga
 *   (`COUNT(*)`), não `entities.length` cego.
 * - D10: `--promote` sem valor é erro (`parsePromoteFlag`); `--release` que não bate com o
 *   release embutido em `--api-base` é erro (`assertReleaseMatchesApiBase`) — fecha o caminho
 *   operacional que produziu o D1.
 * - Execução do CLI fica atrás de `require.main === module`: importar este arquivo em teste NÃO
 *   dispara HTTP nem grava no banco — só os testes que chamam as funções explicitamente o fazem.
 */
import axios from 'axios';
import { Pool, type PoolClient } from 'pg';
import { assertLocalDatabaseTarget } from '../src/shared/database/assertLocalDatabaseTarget';
import { toLocalUri } from './icd11-ingest/rewrite-host';
import { classifyEntity } from './icd11-ingest/classify-entity';
import { diffCatalog, type DiffableEntity } from './icd11-ingest/diff-engine';
import { parsePromoteFlag, assertReleaseMatchesApiBase, parseConcurrencyFlag } from './icd11-ingest/cli-guards';
import type { IcdEntityKind } from '../src/modules/terminology/domain/TerminologyPort';

// ── CLI parsing (molde: backfill-name-trgm-bidx.ts) ─────────────────────────────────────────

export interface RuntimeConfig {
  dryRun: boolean;
  promoteRelease: string | undefined;
  promotedBy: string;
  apiBase: string;
  release: string;
  concurrency: number;
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
}

export const HELP_TEXT = `
Usage: ts-node scripts/ingest-icd11-catalog.ts [options]

Options:
  --dry-run             Crawla e mostra o diff, mas não grava nada.
  --promote <release>   Promove <release> a corrente (is_current=true). Não crawla.
  --by <nome>           Quem promoveu (com --promote). Default: $USER.
  --api-base <url>      Default: $ICD11_API_BASE ou http://localhost:8085/icd/release/11/2026-01/mms
  --release <id>        Default: $ICD11_RELEASE ou 2026-01
  --concurrency <n>     Requests HTTP simultâneos. Default: 16.
  --help                Mostra esta mensagem.
`;

/**
 * Monta a config a partir dos args + env, aplicando as duas defesas do D10. Puro (sem HTTP, sem
 * `pg`) — nenhum efeito colateral acontece antes deste parsing passar.
 */
export function buildRuntimeConfig(args: readonly string[], env: NodeJS.ProcessEnv): RuntimeConfig {
  const promoteRelease = parsePromoteFlag(args);
  const apiBase = flagValue(args, '--api-base') ?? env.ICD11_API_BASE ?? 'http://localhost:8085/icd/release/11/2026-01/mms';
  const release = flagValue(args, '--release') ?? env.ICD11_RELEASE ?? '2026-01';

  if (!promoteRelease) {
    // Só valida release×api-base no caminho de CRAWL — `--promote` não crawla, não há URL a
    // conferir (a promoção só toca `icd_releases`, já gravado por uma ingestão anterior).
    assertReleaseMatchesApiBase(release, apiBase);
  }

  return {
    dryRun: args.includes('--dry-run'),
    promoteRelease,
    promotedBy: flagValue(args, '--by') ?? env.USER ?? 'desconhecido',
    apiBase,
    release,
    concurrency: parseConcurrencyFlag(args),
  };
}

export function createPool(env: NodeJS.ProcessEnv = process.env): Pool {
  const DATABASE_URL = env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
  // Este script ESCREVE 35.692 linhas. O gate `revisao-pr` (BLOQUEADOR 4) achou que ele era o
  // único script de escrita do PR sem trava de alvo. REUSA a trava que já existe em
  // `src/shared/database` — de propósito, em vez de copiar: as 3 cópias de `travaDeAlvo` nos
  // scripts de backfill divergiram e a versão delas APROVA produção via query string.
  assertLocalDatabaseTarget(DATABASE_URL);
  return new Pool({ connectionString: DATABASE_URL });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────

interface RawEntity {
  code?: string;
  classKind?: string;
  title?: { '@value'?: string };
  child?: string[];
  parent?: string[];
}

async function fetchEntity(localUri: string, lang: 'es' | 'en'): Promise<RawEntity> {
  const { data } = await axios.get<RawEntity>(localUri, {
    headers: { 'API-Version': 'v2', 'Accept-Language': lang, Accept: 'application/json' },
    timeout: 15000,
  });
  return data;
}

// ── Concorrência ─────────────────────────────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Crawl ────────────────────────────────────────────────────────────────────────────────────

export interface CrawledEntity {
  icdUri: string;
  code: string;
  titleEs: string | null;
  titleEn: string | null;
  chapter: string;
  parentUri: string | null;
  kind: IcdEntityKind;
  isLeaf: boolean;
}

interface FrontierNode {
  uri: string;
  rootChapterCode: string | null;
}

async function crawlTree(base: string, threads: number): Promise<Map<string, CrawledEntity>> {
  const entities = new Map<string, CrawledEntity>();
  const root = await fetchEntity(base, 'es');
  let frontier: FrontierNode[] = (root.child ?? []).map((uri) => ({ uri, rootChapterCode: null }));

  while (frontier.length > 0) {
    const nextLevels = await mapWithConcurrency(frontier, threads, async (node): Promise<FrontierNode[]> => {
      const localUri = toLocalUri(node.uri, base);
      const data = await fetchEntity(localUri, 'es');
      const code = data.code ?? '';
      const rootChapterCode = node.rootChapterCode ?? code;
      const kind = classifyEntity({ classKind: data.classKind ?? '', rootChapterCode });
      const children = data.child ?? [];

      if (code) {
        entities.set(node.uri, {
          icdUri: node.uri,
          code,
          titleEs: data.title?.['@value'] ?? null,
          titleEn: null,
          chapter: rootChapterCode,
          parentUri: data.parent?.[0] ?? null,
          kind,
          isLeaf: children.length === 0,
        });
      }
      return children.map((childUri) => ({ uri: childUri, rootChapterCode }));
    });
    frontier = nextLevels.flat();
  }
  return entities;
}

async function fillEnglishTitles(entities: Map<string, CrawledEntity>, base: string, threads: number): Promise<void> {
  const uris = Array.from(entities.keys());
  await mapWithConcurrency(uris, threads, async (uri) => {
    const localUri = toLocalUri(uri, base);
    const data = await fetchEntity(localUri, 'en');
    const entity = entities.get(uri);
    if (entity) entity.titleEn = data.title?.['@value'] ?? null;
  });
}

// ── Persistência ─────────────────────────────────────────────────────────────────────────────

export async function loadStored(pool: Pool, forRelease: string): Promise<Map<string, DiffableEntity>> {
  const { rows } = await pool.query<{ icd_uri: string; code: string; title_es: string | null; title_en: string | null }>(
    `SELECT icd_uri, code, title_es, title_en FROM terminology.icd_entities WHERE release = $1`,
    [forRelease],
  );
  const map = new Map<string, DiffableEntity>();
  for (const row of rows) {
    map.set(row.icd_uri, { icdUri: row.icd_uri, code: row.code, titleEs: row.title_es, titleEn: row.title_en });
  }
  return map;
}

async function insertEntityBatch(client: PoolClient, forRelease: string, batch: CrawledEntity[]): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [];
  batch.forEach((e, idx) => {
    const base = idx * 9;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`,
    );
    params.push(e.icdUri, forRelease, e.code, e.titleEs, e.titleEn, e.chapter, e.parentUri, e.kind, e.isLeaf);
  });
  // D1: o alvo do conflito é o PAR (icd_uri, release) — a identidade real da linha (migration
  // 323 corrigida). Ingerir um release diferente nunca colide com a linha de outro release, e
  // por isso nunca precisa (nem pode) reescrever a coluna `release` no SET.
  await client.query(
    `INSERT INTO terminology.icd_entities
       (icd_uri, release, code, title_es, title_en, chapter, parent_uri, kind, is_leaf)
     VALUES ${values.join(', ')}
     ON CONFLICT (icd_uri, release) DO UPDATE SET
       code = EXCLUDED.code,
       title_es = EXCLUDED.title_es,
       title_en = EXCLUDED.title_en,
       chapter = EXCLUDED.chapter,
       parent_uri = EXCLUDED.parent_uri,
       kind = EXCLUDED.kind,
       is_leaf = EXCLUDED.is_leaf,
       updated_at = NOW()`,
    params,
  );
}

const BATCH_SIZE = 500;

/**
 * Grava um release inteiro. D5: TUDO numa única transação — `icd_releases` upsert, todos os
 * batches de `icd_entities`, e a contagem final. Uma falha no meio (rede, constraint, timeout)
 * dá ROLLBACK da transação inteira: zero linhas do release novo ficam gravadas, e o que já
 * existia (deste ou de outro release) não é tocado. `entity_count` é a contagem REAL pós-carga
 * (`COUNT(*) WHERE release = $1`), nunca `entities.length` — um batch que falhou e foi
 * recuperado por retry externo, ou um crawl que colecionou duplicata, não pode fazer o contador
 * mentir.
 */
export async function upsertEntities(pool: Pool, forRelease: string, entities: CrawledEntity[]): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO terminology.icd_releases (release, entity_count) VALUES ($1, 0)
       ON CONFLICT (release) DO NOTHING`,
      [forRelease],
    );

    for (let i = 0; i < entities.length; i += BATCH_SIZE) {
      const batch = entities.slice(i, i + BATCH_SIZE);
      await insertEntityBatch(client, forRelease, batch);
    }

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM terminology.icd_entities WHERE release = $1`,
      [forRelease],
    );
    const realCount = Number(rows[0].count);

    await client.query(`UPDATE terminology.icd_releases SET entity_count = $2, ingested_at = NOW() WHERE release = $1`, [
      forRelease,
      realCount,
    ]);

    await client.query('COMMIT');
    return realCount;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * F1.5-CORREÇÃO C2 (D261) — resultado da reconciliação que `promote()` emite. Só CONTAGEM
 * (`governanca/classificacao-de-dados` item 1: nunca texto clínico em stdout/log) — nunca
 * `concept_code`/`concept_title` de entidade nem qualquer coluna de `patient_diagnoses`.
 *
 * 🔧 F5-CORREÇÃO T1/T4 (QA-caça, 05/09/2026) — três defeitos nesta estrutura, um deles CRÍTICO:
 *
 *  T1 (CRÍTICO, `--promote` quebrado desde a F2): a consulta de pacientes usava `pd.release` e
 *  `pd.icd_uri`; a migration 325 chama essas colunas `catalog_release` e `concept_uri`. Assim
 *  que existisse um release anterior COM órfão, `--promote` levantava
 *  `42703 column pd.release does not exist` DENTRO da transação aberta → o `ROLLBACK` de
 *  `promote()` → **`is_current` nunca se movia**. Dormente só por causa da guarda `to_regclass`
 *  (a tabela não existia na F1). Reproduzido em banco de rascunho antes do conserto.
 *
 *  T4 (a reconciliação não olhava o mapa do ClickUp): `clickup_diagnosis_labels` (migration 326/
 *  327) guarda a URI que o espelho resolve. Promover um release sem olhar para lá deixa os
 *  mapeamentos morrerem em silêncio — nada na tela indica avaria. Agora é uma contagem própria.
 *
 *  T2 (a comparação nunca casava): órfão era medido por `icd_uri`, e a OMS ENCRAVA O RELEASE NO
 *  PATH da URI — `old_e.icd_uri = new_e.icd_uri` é FALSO para todo conceito, sempre. A contagem
 *  reportaria 100% de órfãos em qualquer promoção real. Agora tudo compara por `concept_key`
 *  (migration 328), a identidade estável entre releases.
 */
export interface PromotionReconciliation {
  /** Release que ERA corrente antes desta promoção. `null` na primeira promoção do catálogo. */
  readonly previousRelease: string | null;
  readonly newRelease: string;
  /** Quantos conceitos de `previousRelease` não existem em `newRelease` (por `concept_key`,
   *  NUNCA por `icd_uri` — ver T2 acima). 0 quando não há release anterior (primeira promoção)
   *  ou quando o novo é igual ao anterior. */
  readonly orphanedEntityCount: number;
  /** `patient_diagnoses` é F2 — pode não existir. `to_regclass` decide, sem quebrar. */
  readonly patientDiagnosesTableExists: boolean;
  /** Quantos diagnósticos ATIVOS de paciente apontam para um conceito que o release novo não
   *  tem. `null` = "não verificado" (tabela não existe) — NUNCA `0`, que mentiria "verificado e
   *  limpo" (CLAUDE.md: "contagem zero é falha, nunca sucesso").
   *
   *  ⚠️ NÃO filtra por `catalog_release = previousRelease` (a versão anterior filtrava, e por
   *  isso não enxergava linha gravada em um release mais antigo ainda) nem exige
   *  `orphanedEntityCount > 0` para se dar ao trabalho de contar: as duas eram formas de
   *  devolver 0 sem ter olhado. */
  readonly affectedPatientCount: number | null;
  /** `clickup_diagnosis_labels` é F4 — mesma guarda `to_regclass`. */
  readonly clickupLabelTableExists: boolean;
  /** T4 — quantos mapeamentos ATIVOS do ClickUp deixariam de resolver no release novo. `null` =
   *  não verificado (tabela ausente), nunca 0 por omissão. Contagem, jamais o rótulo. */
  readonly brokenClickupMappingCount: number | null;
}

/**
 * C2/T4 — conta (nunca lê texto) o que a troca de release quebraria. Roda no MESMO
 * client/transação de `promote()` para ver o estado consistente da troca de `is_current`.
 *
 * Toda comparação é por `terminology.concept_key` (migration 328): a identidade do conceito que
 * NÃO muda entre releases. Comparar `icd_uri` é o defeito T2 — a URI carrega o release dentro.
 */
async function tableExists(client: PoolClient, qualifiedName: string): Promise<boolean> {
  const { rows } = await client.query<{ reg: string | null }>(`SELECT to_regclass($1)::text AS reg`, [qualifiedName]);
  return rows[0]?.reg != null;
}

async function countOne(client: PoolClient, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await client.query<{ count: string }>(sql, params);
  return Number(rows[0].count);
}

async function reconcilePromotion(
  client: PoolClient,
  previousRelease: string | null,
  newRelease: string,
): Promise<PromotionReconciliation> {
  let orphanedEntityCount = 0;
  if (previousRelease && previousRelease !== newRelease) {
    orphanedEntityCount = await countOne(
      client,
      `SELECT count(*)::text AS count
         FROM terminology.icd_entities old_e
        WHERE old_e.release = $1
          AND NOT EXISTS (
            SELECT 1 FROM terminology.icd_entities new_e
             WHERE new_e.release = $2 AND new_e.concept_key = old_e.concept_key
          )`,
      [previousRelease, newRelease],
    );
  }

  const patientDiagnosesTableExists = await tableExists(client, 'public.patient_diagnoses');
  const affectedPatientCount = patientDiagnosesTableExists
    ? await countOne(
        client,
        `SELECT count(*)::text AS count
           FROM patient_diagnoses pd
          WHERE pd.active
            AND NOT EXISTS (
              SELECT 1 FROM terminology.icd_entities new_e
               WHERE new_e.release = $1
                 AND new_e.concept_key = terminology.concept_key(pd.concept_uri)
            )`,
        [newRelease],
      )
    : null;

  const clickupLabelTableExists = await tableExists(client, 'public.clickup_diagnosis_labels');
  const brokenClickupMappingCount = clickupLabelTableExists
    ? await countOne(
        client,
        `SELECT count(*)::text AS count
           FROM clickup_diagnosis_labels m
          WHERE m.active
            AND NOT EXISTS (
              SELECT 1 FROM terminology.icd_entities new_e
               WHERE new_e.release = $1
                 AND new_e.concept_key = terminology.concept_key(m.concept_uri)
            )`,
        [newRelease],
      )
    : null;

  return {
    previousRelease,
    newRelease,
    orphanedEntityCount,
    patientDiagnosesTableExists,
    affectedPatientCount,
    clickupLabelTableExists,
    brokenClickupMappingCount,
  };
}

/** C2/T4 — só imprime NÚMEROS. Nunca código, título, rótulo ou coluna de `patient_diagnoses`. */
function printReconciliationReport(r: PromotionReconciliation): void {
  console.log('\n── RECONCILIAÇÃO DE RELEASE (contagem apenas — nunca texto clínico) ──');
  console.log(`release anterior: ${r.previousRelease ?? '(nenhum — primeira promoção)'}`);
  console.log(`release novo: ${r.newRelease}`);
  console.log(`conceitos do release anterior AUSENTES no novo (por concept_key): ${r.orphanedEntityCount}`);
  if (r.patientDiagnosesTableExists) {
    console.log(`diagnósticos ATIVOS de paciente que deixam de resolver: ${r.affectedPatientCount}`);
  } else {
    console.log('tabela patient_diagnoses não existe — reconciliação de pacientes PULADA, NÃO verificada.');
  }
  if (r.clickupLabelTableExists) {
    console.log(`mapeamentos ATIVOS do ClickUp que deixam de resolver: ${r.brokenClickupMappingCount}`);
    if ((r.brokenClickupMappingCount ?? 0) > 0) {
      console.log('   ⚠️  mapeamento que não resolve NÃO grava diagnóstico e NÃO gera linha de rejeição:');
      console.log('       o espelho fica mudo. Reaponte clickup_diagnosis_labels antes de usar o release novo.');
    }
  } else {
    console.log('tabela clickup_diagnosis_labels não existe — mapa do ClickUp NÃO verificado.');
  }
}

export async function promote(pool: Pool, forRelease: string, by: string): Promise<PromotionReconciliation> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ entity_count: number }>(
      `SELECT entity_count FROM terminology.icd_releases WHERE release = $1 FOR UPDATE`,
      [forRelease],
    );
    if (!rows[0]) throw new Error(`Release "${forRelease}" nunca foi ingerido — rode o ingestor antes de promover.`);
    if (rows[0].entity_count === 0) throw new Error(`Release "${forRelease}" tem 0 entidades — não promovo release vazio.`);

    const { rows: prevRows } = await client.query<{ release: string }>(
      `SELECT release FROM terminology.icd_releases WHERE is_current = true`,
    );
    const previousRelease = prevRows[0]?.release ?? null;

    await client.query(
      `UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL WHERE is_current = true`,
    );
    await client.query(
      `UPDATE terminology.icd_releases SET is_current = true, promoted_at = NOW(), promoted_by = $2 WHERE release = $1`,
      [forRelease, by],
    );

    // C2 — reconciliação RODA DENTRO da transação (vê a troca de is_current já aplicada, ainda
    // não commitada) mas só COMMITA se ela também não lançar — reconciliação quebrada não deve
    // deixar a promoção pela metade.
    const reconciliation = await reconcilePromotion(client, previousRelease, forRelease);

    await client.query('COMMIT');
    console.log(`✅ Release "${forRelease}" promovido a corrente por "${by}".`);
    printReconciliationReport(reconciliation);
    return reconciliation;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  if (argv.includes('--help')) {
    console.log(HELP_TEXT);
    return;
  }

  const config = buildRuntimeConfig(argv, env);
  const pool = createPool(env);
  try {
    if (config.promoteRelease) {
      await promote(pool, config.promoteRelease, config.promotedBy);
      return;
    }

    console.log(`🕸️  Crawl (es) a partir de ${config.apiBase} — concorrência ${config.concurrency}...`);
    const t0 = Date.now();
    const crawled = await crawlTree(config.apiBase, config.concurrency);
    console.log(`   ${crawled.size} entidades com código em ${((Date.now() - t0) / 1000).toFixed(1)}s.`);

    console.log(`🕸️  2ª passada (en) para completar título em inglês...`);
    const t1 = Date.now();
    await fillEnglishTitles(crawled, config.apiBase, config.concurrency);
    console.log(`   concluído em ${((Date.now() - t1) / 1000).toFixed(1)}s.`);

    const stored = await loadStored(pool, config.release);
    const crawledDiffable = new Map<string, DiffableEntity>();
    for (const [uri, e] of crawled) {
      crawledDiffable.set(uri, { icdUri: uri, code: e.code, titleEs: e.titleEs, titleEn: e.titleEn });
    }
    const diff = diffCatalog(crawledDiffable, stored);

    console.log('\n── DIFF contra o banco (release ' + config.release + ') ──────────────────────');
    console.log(`entraram:        ${diff.entered}`);
    console.log(`saíram:          ${diff.left} (não removidos automaticamente — ver relatório)`);
    console.log(`mudaram título:  ${diff.changedTitle}`);
    console.log(`sem mudança:     ${diff.unchanged}`);
    if (diff.changedSamples.length > 0) {
      console.log('amostra de mudanças de título:');
      for (const s of diff.changedSamples) {
        console.log(`  ${s.code} (${s.icdUri}): "${s.before}" → "${s.after}"`);
      }
    }

    const byKind = { chapter: 0, stem: 0, extension: 0 };
    for (const e of crawled.values()) byKind[e.kind]++;
    console.log(`\npor kind: chapter=${byKind.chapter} stem=${byKind.stem} extension=${byKind.extension}`);

    if (config.dryRun) {
      console.log('\n--dry-run: nada foi gravado.');
      return;
    }

    console.log(`\n💾 Gravando ${crawled.size} entidades em terminology.icd_entities (release=${config.release})...`);
    const realCount = await upsertEntities(pool, config.release, Array.from(crawled.values()));
    console.log(`✅ Ingestão concluída (${realCount} linhas reais). Release NÃO promovido automaticamente — use --promote para tornar corrente.`);
  } finally {
    await pool.end();
  }
}

/* istanbul ignore next -- entrypoint do CLI: só roda fora de teste (require.main === module) */
if (require.main === module) {
  main(process.argv.slice(2), process.env).catch((err) => {
    console.error('❌ Falha na ingestão:', err.message ?? err);
    process.exit(1);
  });
}
