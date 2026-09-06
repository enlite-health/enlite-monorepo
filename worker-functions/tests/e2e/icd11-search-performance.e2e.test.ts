/**
 * F1-CORREÇÃO D6 (spec 016) — prova AUTOMATIZADA de que a busca usa o índice GIN de pg_trgm.
 * Medido: `word_similarity(a,b) >= 0.3` NÃO é indexável (Seq Scan, 212ms no catálogo real de
 * 35.692 linhas); o operador `%>` (comutador de `<%`) É indexável pelo mesmo índice GIN.
 * A evidência MANUAL do plano ESCOLHIDO livremente pelo planner (sem forçar nada) está em
 * `evidencias/f1fix-D6-explain-analyze.txt` — Bitmap Index Scan, 2.136ms.
 *
 * 🔴 Por que este teste automatizado usa `enable_seqscan = off` em vez de deixar o planner
 * escolher livre: MEDIDO que a escolha "natural" do planner é sensível a estatística (rodando
 * junto com `icd11-unavailable-real-catalog.e2e.test.ts`, que faz DROP+recria+re-ingesta a
 * tabela inteira, o custo estimado de Bitmap (~233) e Seq Scan (~233) empatam quase exatamente
 * — ora um ganha, ora outro, sem que o predicado deixe de ser indexável). O que o D6 exige de
 * verdade é uma propriedade ESTRUTURAL — "o operador é indexável" — não uma aposta em qual
 * plano o cost-based optimizer prefere num instante específico. `enable_seqscan = off` isola
 * exatamente isso: com a forma NOVA (`%>`), o planner AINDA TEM uma alternativa indexável e a
 * usa; com a forma ANTIGA (`word_similarity(...) >= 0.3`), não existe alternativa nenhuma —
 * `enable_seqscan=off` não impede um Seq Scan que é a ÚNICA opção. Isso torna o teste
 * determinístico, sem deixar de pegar a regressão real (reverter para a forma não-indexável).
 */
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Total Time'?: number;
  Plans?: PlanNode[];
}

function findNode(node: PlanNode, predicate: (n: PlanNode) => boolean): PlanNode | undefined {
  if (predicate(node)) return node;
  for (const child of node.Plans ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return undefined;
}

describe('D6 — busca usa Bitmap Index Scan (pg_trgm GIN), não Seq Scan', () => {
  // Nota: as duas queries abaixo filtram `release = $2` DIRETO (não passam por
  // `resolveCurrentRelease()`/`is_current`) — o alvo aqui é só o PLANO de execução do predicado
  // de trigrama, não o comportamento do adaptador (isso já é coberto no contrato/D2). Por isso
  // este teste não precisa promover nada; roda contra o release 2026-01 já ingerido, esteja ou
  // não marcado corrente.
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Estatísticas frescas: outros arquivos e2e desta mesma suíte gravam/removem releases de
    // teste em terminology.icd_entities (D1/D2/D3/D5/D8) — sem ANALYZE, o planner pode herdar
    // estimativas de cardinalidade de um estado intermediário e escolher um plano diferente
    // (medido: rodando junto com os outros arquivos, sem ANALYZE aqui, o planner às vezes
    // preferia `idx_icd_entities_release` a `idx_icd_entities_title_es_trgm` — falso negativo
    // deste teste, não uma regressão real do D6).
    await pool.query('VACUUM (ANALYZE) terminology.icd_entities');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('EXPLAIN ANALYZE da query real (%>) mostra Bitmap Index Scan no índice de trigrama', async () => {
    const client = await pool.connect();
    let plan: PlanNode;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL pg_trgm.word_similarity_threshold = 0.3');
      // Determinístico: força o planner a preferir o índice quando ele EXISTE como opção — ver
      // o porquê no comentário do topo do arquivo. Não afeta a query da forma antiga (2º teste
      // abaixo), que não tem alternativa indexável de qualquer forma.
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query(
        `EXPLAIN (ANALYZE, FORMAT JSON)
           SELECT icd_uri, code, title_es, title_en, chapter,
                  GREATEST(word_similarity($1, title_es), word_similarity($1, title_en)) AS sim
             FROM terminology.icd_entities
            WHERE release = $2
              AND (title_es %> $1 OR title_en %> $1)
              AND kind <> 'chapter'
              AND kind <> 'extension'
            ORDER BY sim DESC, code ASC
            LIMIT 50`,
        ['esquisofrenia', '2026-01'],
      );
      await client.query('COMMIT');
      plan = rows[0]['QUERY PLAN'][0].Plan as PlanNode;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const bitmapIndexScan = findNode(plan, (n) => n['Node Type'] === 'Bitmap Index Scan');
    expect(bitmapIndexScan).toBeDefined();
    expect(bitmapIndexScan?.['Index Name']).toMatch(/idx_icd_entities_title_(es|en)_trgm/);

    const seqScan = findNode(plan, (n) => n['Node Type'] === 'Seq Scan');
    expect(seqScan).toBeUndefined(); // a regressão que este teste existe para pegar: predicado não-indexável força Seq Scan

    // eslint-disable-next-line no-console
    console.log('D6 EXPLAIN plan (resumo):', JSON.stringify({ root: plan['Node Type'], bitmapIndexScan }, null, 2));
  });

  it('NÃO indexável (a forma antiga, `word_similarity(...) >= 0.3`) força Seq Scan — a prova do porquê da correção', async () => {
    const { rows } = await pool.query(
      `EXPLAIN (ANALYZE, FORMAT JSON)
         SELECT icd_uri FROM terminology.icd_entities
        WHERE release = $2 AND word_similarity($1, title_es) >= 0.3
        LIMIT 50`,
      ['esquisofrenia', '2026-01'],
    );
    const plan = rows[0]['QUERY PLAN'][0].Plan as PlanNode;
    const seqScan = findNode(plan, (n) => n['Node Type'] === 'Seq Scan');
    expect(seqScan).toBeDefined();
  });
});
