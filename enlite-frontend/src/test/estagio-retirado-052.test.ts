/**
 * Spec 052 (Fase 4) — o estágio de funil "Confirmado" saiu do produto. Esta varredura é a régua do
 * "nenhuma leitura fora de migration" no front: reintroduzir a palavra em código, locale, teste, e2e do
 * front ou `e2e-prod` deixa este teste vermelho (testid, chave i18n e id de coluna incluídos).
 *
 * O valor é montado em duas partes de propósito: este arquivo não precisa de exceção na lista e a
 * varredura não se acusa a si mesma. Lado do backend: `worker-functions/src/shared/__tests__/estagio-retirado-052.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const RETIRADO = ['CONFIRM', 'ED'].join('');
/** Palavra inteira (como `grep -w`; cobre `kanban-column-<valor>`, `columns.<valor>`) OU a chave `stage_<valor>` da ajuda do painel. */
const PADRAO = new RegExp(`\\b${RETIRADO}\\b|stage_${RETIRADO}`);

const FRONT = resolve(__dirname, '../..'); // enlite-frontend/
const MONOREPO = resolve(FRONT, '..');
const RAIZES = [join(FRONT, 'src'), join(FRONT, 'e2e'), join(MONOREPO, 'e2e-prod')];
const IGNORAR = new Set(['node_modules', 'dist', 'coverage', '.git', 'test-results', 'playwright-report']);

/**
 * LISTA EXPLÍCITA dos que podem conter a palavra, com o motivo. No front e no `e2e-prod` ela é VAZIA:
 * não há homônimo (o estado de vínculo de identidade de paciente é só do backend). Entrada nova exige
 * justificativa em revisão; entrada que deixa de conter a palavra reprova.
 */
const PERMITIDOS: Record<string, string> = {};

function arquivos(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (IGNORAR.has(nome)) continue;
    const caminho = join(dir, nome);
    const st = statSync(caminho);
    if (st.isDirectory()) arquivos(caminho, saida);
    else if (st.size < 2_000_000) saida.push(caminho);
  }
  return saida;
}

function contem(caminho: string): boolean {
  const buf = readFileSync(caminho);
  if (buf.includes(0)) return false; // binário (png de baseline etc.)
  return PADRAO.test(buf.toString('utf8'));
}

describe('spec 052 — o estágio retirado não volta ao front nem ao e2e-prod', () => {
  const todos = RAIZES.flatMap((r) => arquivos(r));
  const achados = todos.filter(contem).map((f) => relative(MONOREPO, f).split('\\').join('/')).sort();

  it('a varredura enxerga os três lados (contagem zero é falha, não sucesso)', () => {
    expect(todos.filter((f) => f.startsWith(join(FRONT, 'src'))).length).toBeGreaterThan(500);
    expect(todos.filter((f) => f.startsWith(join(FRONT, 'e2e'))).length).toBeGreaterThan(50);
    expect(todos.filter((f) => f.startsWith(join(MONOREPO, 'e2e-prod'))).length).toBeGreaterThan(20);
  });

  it('controle positivo: o padrão acha o valor, o testid, a chave i18n e a chave da ajuda', () => {
    expect(PADRAO.test(`stage === '${RETIRADO}'`)).toBe(true);
    expect(PADRAO.test(`kanban-column-${RETIRADO}`)).toBe(true);
    expect(PADRAO.test(`admin.kanban.columns.${RETIRADO}`)).toBe(true);
    expect(PADRAO.test(`'stage_${RETIRADO}'`)).toBe(true);
    expect(PADRAO.test(`UN${RETIRADO}_WRITE`)).toBe(false);
  });

  it('nenhum arquivo do front, dos e2e ou do e2e-prod contém a palavra fora da lista de permitidos', () => {
    const fora = achados.filter((f) => !(f in PERMITIDOS));
    expect(fora).toEqual([]);
  });

  it('cada permitido ainda contém a palavra (a lista não apodrece)', () => {
    const semPalavra = Object.keys(PERMITIDOS).filter((f) => !achados.includes(f));
    expect(semPalavra).toEqual([]);
  });
});
