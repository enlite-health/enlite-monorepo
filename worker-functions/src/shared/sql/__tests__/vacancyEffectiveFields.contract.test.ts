/**
 * Controle mecânico da change `vaga-le-do-servico-contratado` (F1): NENHUM leitor lê o horário cru da vaga.
 *
 * Varre `worker-functions/src` e `worker-functions/scripts` (menos testes) e reprova o arquivo que, fora da peça
 * `vacancyEffectiveFieldsSql.ts` e fora da ALLOWLIST abaixo, (a) lê `<alias>.schedule` de `job_postings`, (b) lê
 * `schedule` sem alias numa query sobre `job_postings`, ou (c) faz `SELECT *`/`<alias>.*`/`RETURNING *` em `job_postings`
 * (a lista de colunas vive na peça).
 *
 * Estruturado por CAMPO: `providers_needed` (F5) e `age_range_min|max` (F6) entram em PROTECTED_FIELDS depois.
 *
 * LIMITE HONESTO: é regex sobre texto. NÃO vê SQL montado dinamicamente (ex.: `SET ${key} = $1` do PUT, coluna vinda
 * de variável) nem alias passado entre arquivos. Quem cobre isso é o teste por EFEITO (`singleSource`: muda o serviço,
 * lê no consumidor), que não depende de regex. Arquivos de teste não são varridos (não são leitores de produção).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  EFFECTIVE_FIELD_EXPRESSIONS,
  JOB_POSTING_COLUMNS,
  vacancyEffectiveColumnsSql,
  vacancyEffectiveJoinSql,
  vacancyEffectiveScheduleSql,
  vacancyRawColumnsSql,
} from '../vacancyEffectiveFieldsSql';

const ROOT = path.resolve(__dirname, '../../../..'); // worker-functions/
const PIECE = 'src/shared/sql/vacancyEffectiveFieldsSql.ts';

/** Campos da vaga que passam a ser lidos do serviço. Acrescentar aqui na F5/F6. */
const PROTECTED_FIELDS = ['schedule'];

type RuleId = `${string}:alias` | `${string}:bare` | 'star' | 'raw-export';

/**
 * ALLOWLIST explícita e DECRESCENTE: só os ESCRITORES (F2 do fatos-medidos). Cada entrada diz QUAIS regras dispensa.
 * Uma entrada que não dispensa nada é reprovada (o teste "allowlist sem entrada morta").
 */
const ALLOWLIST: Record<string, { rules: RuleId[]; motivo: string }> = {

  'src/modules/matching/interfaces/controllers/VacancyCrudController.ts': {
    rules: ['raw-export'],
    motivo: 'LEITOR 13 em client cru (connect() sem identidade): SELECT/RETURNING com lista explícita SEM join, só para auditar o que foi gravado; a resposta traz o efetivo via withEffectiveSchedule.',
  },
  'src/modules/matching/interfaces/controllers/vacancyCrudHelpers.ts': {
    rules: ['schedule:bare', 'raw-export'],
    motivo: 'ESCRITOR (F2): INSERT único copia o horário; o RETURNING crua serve ao client cru (leitor 13), a resposta traz o efetivo via withEffectiveSchedule.',
  },
  'scripts/enrich-vacancies-helpers.ts': {
    rules: ['schedule:bare'],
    motivo: 'ESCRITOR (F2): UPDATE do enrichment (:276-278 e :302), sem chamador em src; escreve, não lê.',
  },
};

const KEYWORDS = new Set([
  'where', 'on', 'left', 'right', 'inner', 'outer', 'cross', 'full', 'join', 'set', 'group', 'order', 'limit',
  'using', 'as', 'natural', 'returning', 'values', 'select', 'union', 'having', 'offset', 'for', 'and', 'or',
]);

export interface Violation { rule: RuleId; excerpt: string }

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[\s;{(,])\/\/.*$/gm, '$1')
    .replace(/(^|\s)--\s.*$/gm, '$1');
}

/** Aliases ligados a `job_postings` no texto (`FROM|JOIN|UPDATE job_postings [AS] alias`). */
function jobPostingAliases(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/\b(?:FROM|JOIN|UPDATE)\s+job_postings\s+(?:AS\s+)?([a-z_][a-z0-9_]*)/gi)) {
    if (!KEYWORDS.has(m[1].toLowerCase())) out.add(m[1]);
  }
  return [...out];
}

export function scanSource(raw: string): Violation[] {
  const src = stripComments(raw);
  const found: Violation[] = [];
  const add = (rule: RuleId, m: RegExpMatchArray | null) => {
    if (m) found.push({ rule, excerpt: m[0].replace(/\s+/g, ' ').slice(0, 90) });
  };
  const aliases = jobPostingAliases(src);

  for (const f of PROTECTED_FIELDS) {
    // (a) `<alias>.campo` com alias ligado a job_postings neste arquivo, ou o alias usual `jp*` em qualquer arquivo
    //     (cobre o fragmento que recebe o alias de fora, como o filtro de horário).
    for (const a of aliases) add(`${f}:alias`, src.match(new RegExp(`\\b${a}\\.${f}\\b`)));
    add(`${f}:alias`, src.match(new RegExp(`\\bjp[a-z0-9_]*\\.${f}\\b`)));
    // (b) campo sem alias dentro de um literal que fala de job_postings
    //     (`AS campo` é nome de SAÍDA do efetivo, não leitura da coluna)
    const bare = new RegExp(`(?<![.\\w$])${f}(?!\\w)`);
    const noAlias = (t: string) => t.replace(new RegExp(`\\bAS\\s+${f}\\b`, 'gi'), 'AS _');
    for (const lit of src.split('`').filter((_, i) => i % 2 === 1)) { // só o que está ENTRE crases
      if (!/job_postings/i.test(lit)) continue;
      add(`${f}:bare`, noAlias(lit).match(bare));
    }
    for (const lit of src.match(/'[^'\n]*job_postings[^'\n]*'/gi) ?? []) {
      add(`${f}:bare`, noAlias(lit).match(bare));
    }
  }

  // (d) exports da peça que entregam o valor CRU da cópia (lista de colunas inclui `schedule`): só quem está na allowlist
  add('raw-export', src.match(/\b(?:vacancyRawColumnsSql|JOB_POSTING_COLUMNS)\b/));

  // (c) formas `*`
  add('star', src.match(/\bSELECT\s+\*\s+FROM\s+job_postings\b/i));
  add('star', src.match(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+job_postings\b[^`'"]{0,4000}?RETURNING\s+\*/i));
  for (const a of aliases) add('star', src.match(new RegExp(`\\b${a}\\.\\*`)));
  return found;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '__tests__' || e.name === 'coverage') continue;
      walk(p, acc);
    } else if (/\.(ts|js|mjs|cjs)$/.test(e.name) && !/\.(test|spec)\.[tj]s$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

const FILES = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))]
  .map((f) => path.relative(ROOT, f))
  .filter((f) => f !== PIECE);
const SCANNED = new Map(FILES.map((f) => [f, scanSource(fs.readFileSync(path.join(ROOT, f), 'utf8'))]));

describe('vacancyEffectiveFields — contrato: ninguém lê o horário cru da vaga', () => {
  it('a varredura enxerga arquivos de verdade (contagem zero é falha)', () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES).toContain('src/modules/matching/infrastructure/JobPostingARRepository.ts');
    expect(FILES).toContain('scripts/enrich-vacancies-helpers.ts');
  });

  it('nenhum arquivo fora da peça e da allowlist lê `schedule` cru ou faz SELECT/RETURNING * em job_postings', () => {
    const bad: string[] = [];
    for (const [file, vs] of SCANNED) {
      const allowed = new Set(ALLOWLIST[file]?.rules ?? []);
      for (const v of vs) if (!allowed.has(v.rule)) bad.push(`${file} [${v.rule}] ${v.excerpt}`);
    }
    expect(bad).toEqual([]);
  });

  it('allowlist sem entrada morta: cada regra dispensada ainda é usada pelo arquivo', () => {
    for (const [file, entry] of Object.entries(ALLOWLIST)) {
      expect(FILES).toContain(file);
      const seen = new Set((SCANNED.get(file) ?? []).map((v) => v.rule));
      for (const r of entry.rules) expect({ file, rule: r, usada: seen.has(r) }).toEqual({ file, rule: r, usada: true });
      expect(entry.motivo.length).toBeGreaterThan(20);
    }
  });

  describe('autoteste do scanner (os dois lados)', () => {
    it('REPROVA leitura crua, em qualquer alias, sem alias e as formas *', () => {
      const ruins: Array<[string, RuleId]> = [
        ['`SELECT jp.schedule FROM job_postings jp WHERE jp.id = $1`', 'schedule:alias'],
        ['`SELECT j2.schedule FROM job_postings AS j2`', 'schedule:alias'],
        ['`SELECT jsonb_array_elements(jp9.schedule) FROM x`', 'schedule:alias'],
        ['`SELECT schedule FROM job_postings WHERE id = $1`', 'schedule:bare'],
        ["'SELECT schedule FROM job_postings'", 'schedule:bare'],
        ['`SELECT * FROM job_postings WHERE id = $1`', 'star'],
        ['import { vacancyRawColumnsSql } from \'@shared/sql/vacancyEffectiveFieldsSql\';', 'raw-export'],
        ['const c = JOB_POSTING_COLUMNS;', 'raw-export'],
        ['`SELECT jp.* FROM job_postings jp`', 'star'],
        ['`UPDATE job_postings SET title = $1 WHERE id = $2 RETURNING *`', 'star'],
        ['`INSERT INTO job_postings (a) VALUES ($1) RETURNING *`', 'star'],
      ];
      for (const [code, rule] of ruins) expect({ code, rules: scanSource(code).map((v) => v.rule) }).toEqual({ code, rules: expect.arrayContaining([rule]) });
    });

    it('APROVA o que passa pela peça, colunas irmãs e outras tabelas', () => {
      const bons = [
        '`SELECT ${vacancyEffectiveScheduleSql(\'jp\')} AS schedule FROM job_postings jp ${vacancyEffectiveJoinSql(\'jp\')}`',
        '`SELECT jp.schedule_days_hours, jp.work_schedule FROM job_postings jp`',
        '`SELECT pcs.schedule FROM patient_contracted_services pcs`',
        '`UPDATE workers SET a = 1 RETURNING *`',
        '// SELECT jp.schedule FROM job_postings jp\n`SELECT 1`',
      ];
      for (const code of bons) expect({ code, v: scanSource(code) }).toEqual({ code, v: [] });
    });
  });

  describe('a peça', () => {
    it('o horário efetivo é CASE (serviço manda quando há serviço), nunca COALESCE(serviço, vaga)', () => {
      expect(vacancyEffectiveScheduleSql('jp', 'e')).toBe(
        'CASE WHEN jp.contracted_service_id IS NOT NULL THEN e.schedule ELSE jp.schedule END',
      );
      expect(vacancyEffectiveScheduleSql()).not.toMatch(/COALESCE/i);
      expect(vacancyEffectiveJoinSql('jp', 'e')).toBe('LEFT JOIN patient_contracted_services e ON e.id = jp.contracted_service_id');
    });

    it('a lista explícita troca só as colunas migradas e mantém os nomes de saída', () => {
      const cols = vacancyEffectiveColumnsSql('jp', 'e');
      expect(cols).toContain(`${EFFECTIVE_FIELD_EXPRESSIONS.schedule('jp', 'e')} AS schedule`);
      expect(cols.split(', ').length).toBe(JOB_POSTING_COLUMNS.length);
      expect(cols).toContain('jp.work_schedule');
      expect(new Set(JOB_POSTING_COLUMNS).size).toBe(JOB_POSTING_COLUMNS.length);
      expect(vacancyRawColumnsSql().split(', ')).toEqual([...JOB_POSTING_COLUMNS]);
    });
  });
});
