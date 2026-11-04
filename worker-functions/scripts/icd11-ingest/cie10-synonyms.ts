/**
 * cie10-synonyms — GERADOR da migration 560: sinônimos de busca do CID-10 (capítulo V, F00-F99) na
 * entidade que a OMS mapeia no CID-11. Roda uma vez, à mão (`scripts/gen-cie10-synonyms-migration.ts`);
 * o resultado é a migration commitada. Nada aqui toca o banco nem o ingestor do catálogo.
 *
 * Duas fontes OFICIAIS, lidas de arquivo (nada escrito de memória):
 *  1. Tabela de mapeamento CID-10→CID-11 da OMS (`mapping.zip` → `10To11MapToOneCategory.txt`,
 *     download público em icd.who.int/browse11/Downloads): dá o par código CID-10 → código CID-11.
 *  2. Títulos em espanhol da CIE-10 da OPS/OMS (Publicación Científica 554, vol. 1,
 *     ais.paho.org/classifications/Chapters/pdf/Volume1.pdf), convertido com `pdftotext -layout`.
 *
 * Cada código CID-10 mapeado gera até dois sinônimos da entidade CID-11 de destino: o próprio
 * código ("F70") — para quem busca por código — e o título CIE-10 em espanhol da OPS. Funções puras.
 */

export const CIE10_CODE_SOURCE = 'who-icd10to11map:code';
export const CIE10_TITLE_SOURCE = 'ops-cie10-es:title';

export interface Cie10Mapping {
  code10: string;
  code11: string;
}

const F_CATEGORY = /^F\d{2}(\.\d)?$/;

/** Pares CID-10 (categoria F00-F99) → código CID-11 do `10To11MapToOneCategory.txt`. Pós-coordenação (`A&B`) fica com o código-tronco. */
export function parseCie10Map(text: string): Cie10Mapping[] {
  const lines = text.split(/\r?\n/);
  const header = lines[0]?.split('\t') ?? [];
  const iKind = header.indexOf('10ClassKind');
  const iCode10 = header.indexOf('icd10Code');
  const iCode11 = header.indexOf('icd11Code');
  if (iKind < 0 || iCode10 < 0 || iCode11 < 0) {
    throw new Error('Arquivo de mapeamento sem as colunas 10ClassKind/icd10Code/icd11Code — não é o 10To11MapToOneCategory da OMS.');
  }
  const out: Cie10Mapping[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const code10 = (cols[iCode10] ?? '').trim();
    if (cols[iKind] !== 'category' || !F_CATEGORY.test(code10) || seen.has(code10)) continue;
    const code11 = (cols[iCode11] ?? '').split(/[&/]/)[0].trim();
    if (!code11) continue;
    seen.add(code10);
    out.push({ code10, code11 });
  }
  return out;
}

const TITLE_LINE = /^(F\d{2}(?:\.\d)?)[*†]?\s+(\S.*)$/;
const CONTINUATION = /^\s+[a-zñ(]/;

/**
 * Títulos ES do capítulo V da CIE-10 (OPS) a partir do texto de `pdftotext -layout`. O volume traz
 * o capítulo V duas vezes: no ÍNDICE RESUMIDO do começo (todas as categorias de 3 caracteres, sem
 * descrição) e na LISTA TABULAR (subdivisões de 4 caracteres; as categorias que têm subdivisões
 * aparecem ali sem a linha de título). Lê as duas regiões (de "F00" até "G00") e o resumo vence nas
 * categorias de 3 caracteres. Título quebrado em mais de uma linha é juntado enquanto a linha
 * seguinte for recuada e começar em minúscula (parágrafo de descrição começa em maiúscula);
 * hifenização de fim de linha é desfeita.
 */
export function parseOpsTitles(text: string): Map<string, string> {
  const lines = text.split(/\r?\n/);
  const starts = lines.map((l, i) => (/^F00[*†]?\s+Demencia en la enfermedad de Alzheimer/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (starts.length < 2) throw new Error('Texto da CIE-10 sem as duas ocorrências do capítulo V (índice resumido e lista tabular).');
  const titles = new Map<string, string>();
  for (const from of starts.slice(0, 2)) {
    for (let i = from; i < lines.length; i++) {
      if (/^G00\s/.test(lines[i])) break;
      const m = TITLE_LINE.exec(lines[i]);
      if (!m) continue;
      let title = m[2].trim();
      for (let j = i + 1; j < lines.length && j <= i + 3 && CONTINUATION.test(lines[j]); j++) {
        const next = lines[j].trim();
        title = title.endsWith('-') ? title.slice(0, -1) + next : `${title} ${next}`;
      }
      if (!titles.has(m[1])) titles.set(m[1], title.replace(/\s+/g, ' '));
    }
  }
  return titles;
}

export interface Cie10SynonymSeed {
  term: string;
  source: typeof CIE10_CODE_SOURCE | typeof CIE10_TITLE_SOURCE;
  code11: string;
}

/** Uma linha por sinônimo: o código CID-10 e, quando a OPS tem título para ele, o título ES. */
export function buildCie10Seeds(mappings: readonly Cie10Mapping[], titles: ReadonlyMap<string, string>): Cie10SynonymSeed[] {
  const seeds: Cie10SynonymSeed[] = [];
  for (const { code10, code11 } of mappings) {
    seeds.push({ term: code10, source: CIE10_CODE_SOURCE, code11 });
    const title = titles.get(code10);
    if (title) seeds.push({ term: title, source: CIE10_TITLE_SOURCE, code11 });
  }
  return seeds;
}

const sqlText = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** O arquivo SQL da migration 560, inteiro (cabeçalho, COMMENT e a carga com `RAISE NOTICE`). */
export function renderCie10Migration(seeds: readonly Cie10SynonymSeed[]): string {
  const values = seeds.map((s) => `  (${sqlText(s.term)}, ${sqlText(s.source)}, ${sqlText(s.code11)})`).join(',\n');
  return `-- 560 — sinônimos de busca do CID-10 de saúde mental (F00-F99) no catálogo CID-11.
--
-- GERADO por scripts/gen-cie10-synonyms-migration.ts (não editar à mão; rode o gerador de novo).
--
-- Por quê: a busca por "retraso mental leve" não achava 6A00.0 ("Trastorno del desarrollo
-- intelectual, leve") e a por "F70" não achava nada: a CID-11 renomeou/reorganizou os diagnósticos
-- e a clínica ainda digita o nome e o código do CID-10. Decisão do Gabriel (03/11/2026): levar as
-- diferenças de saúde mental do CID-10 para o CID-11, como ponte de vocabulário, com a origem
-- marcada por linha em created_by:
--   · 'who-icd10to11map:code'  código CID-10 (ex. "F70") na entidade CID-11 para a qual a tabela de
--     mapeamento CID-10→CID-11 da OMS (10To11MapToOneCategory, mapping.zip público) o leva.
--   · 'ops-cie10-es:title'     título em espanhol do mesmo código na CIE-10 da OPS/OMS (Publicación
--     Científica 554, vol. 1).
-- NÃO entra o indexTerm[] da OMS: a 323 manda a tabela ser conteúdo curado pela Enlite.
--
-- Chega a prd NO DEPLOY, sem passo manual. Une os pares ao catálogo pelo código CID-11 no release
-- CORRENTE; onde o catálogo não existe (CI, banco novo) insere 0 linhas e NÃO falha. Idempotente
-- (ON CONFLICT no índice único (icd_uri, release, lower(term), lang)). Emite um NOTICE com as contagens:
-- esperadas (linhas da carga), com entidade no catálogo e inseridas — zero não passa calado.
-- "esperadas" - "inseridas" = título repetido na mesma entidade (vários códigos F vão para a mesma
-- entidade) ou linha já existente.
--
-- ⚠️ Cláusula 1.2.3 da licença: mapeamentos CID-10↔CID-11 e traduções "are not covered by the ICD-11
-- License". A tabela é publicada pela OMS para download e os títulos são da OPS/OMS, mas o uso aqui é
-- decisão do Gabriel (D260, sem parecer jurídico).
--
-- Rollback: DELETE FROM terminology.icd_synonyms WHERE created_by IN ('who-icd10to11map:code',
-- 'ops-cie10-es:title'); e voltar o COMMENT da 323.
COMMENT ON TABLE terminology.icd_synonyms IS
  'ATENÇÃO: conteúdo CURADO PELA ENLITE — NÃO é original da OMS. Existe por permissão explícita '
  'da cláusula 1.2.4 da licença ICD-11 ("adding data fields... permitted if clearly identified '
  'as additions that do not originate from WHO"). Adicionado editorialmente pela operação (gíria, '
  'sigla regional) — nunca por importação automática de conteúdo da OMS (ex.: NÃO copiar o '
  'indexTerm[] da API aqui). Exceção por decisão do Gabriel em 03/11/2026: as linhas com '
  'created_by = ''who-icd10to11map:code'' (código CID-10 pelo mapeamento da OMS) e '
  '''ops-cie10-es:title'' (título CIE-10 em espanhol da OPS) entraram como ponte de vocabulário '
  'CID-10→CID-11 de saúde mental (F00-F99), com a origem marcada por linha.';

DO $$
DECLARE
  esperadas INT;
  com_entidade INT;
  inseridas INT;
BEGIN
  CREATE TEMP TABLE _cie10_seed (term TEXT, source TEXT, code11 TEXT) ON COMMIT DROP;
  INSERT INTO _cie10_seed (term, source, code11) VALUES
${values};

  SELECT count(*) INTO esperadas FROM _cie10_seed;
  SELECT count(*) INTO com_entidade
    FROM _cie10_seed v
    JOIN terminology.icd_releases r ON r.is_current
    JOIN terminology.icd_entities e ON e.release = r.release AND e.code = v.code11 AND e.kind <> 'chapter';

  INSERT INTO terminology.icd_synonyms (icd_uri, release, term, lang, created_by)
  SELECT e.icd_uri, e.release, v.term, 'es', v.source
    FROM _cie10_seed v
    JOIN terminology.icd_releases r ON r.is_current
    JOIN terminology.icd_entities e ON e.release = r.release AND e.code = v.code11 AND e.kind <> 'chapter'
  ON CONFLICT (icd_uri, release, lower(term), lang) DO NOTHING;
  GET DIAGNOSTICS inseridas = ROW_COUNT;

  RAISE NOTICE '560 CID-10 F00-F99: esperadas=%, com entidade no release corrente=%, inseridas=%', esperadas, com_entidade, inseridas;
END
$$;
`;
}
