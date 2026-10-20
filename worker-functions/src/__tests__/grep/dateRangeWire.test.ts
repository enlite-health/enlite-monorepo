/**
 * Grep-teste da T046 (spec 058): a conversão `daterange '[)'` <-> wire mora SÓ em `case/domain/dateRangeWire.ts`.
 * Nenhum outro arquivo de `src` (fora de testes) pode escrever `upper(valid)`/`lower(valid)`/`upper_inf(valid)`, `inclusiveValidTo*`,
 * `::daterange` ou o literal `'[)'`. (SQL de migration mora em `migrations/`, fora de `src`.)
 * Controle: o padrão TEM de casar nos exemplos ruins (um grep que não acha nada é "não medi") e o scanner TEM de enxergar arquivos.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../..');
const PROIBIDO = /(upper|lower|upper_inf)\(\s*(\w+\.)?valid|inclusiveValidTo|::daterange|'\[\)'/;
const DONO = path.join('modules', 'case', 'domain', 'dateRangeWire.ts');

/**
 * Interinidade declarada do sync main -> stage (20/10): o código da spec 056 (horas com dono único, só na stage até a Parte B) escreve
 * `daterange`/`upper(valid)` por conta própria. Migrar esses 5 arquivos para `dateRangeWire.ts` muda o código da 056 e fica para a Parte B;
 * a lista é FECHADA (arquivo novo fora dela reprova) e o teste abaixo falha se um item sair de lá sem necessidade (lista velha = achado).
 */
const INTERINIDADE_056 = [
  'shared/openapi/registrations/adminPatients.ts',
];

function fontes(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      fontes(full, out);
    } else if (/\.ts$/.test(e.name) && !/\.(test|spec)\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(full);
  }
  return out;
}

describe('grep-teste: conversão de daterange só em dateRangeWire.ts', () => {
  const todas = fontes(SRC);

  it('o scanner enxerga o dono e os arquivos de src (contagem zero seria "não medi")', () => {
    expect(todas.length).toBeGreaterThan(100);
    expect(todas.some((f) => f.endsWith(DONO))).toBe(true);
  });

  it('o padrão casa nos exemplos ruins (controle positivo)', () => {
    for (const ruim of ['upper(valid)', 'lower( p.valid )', 'upper_inf(valid)', 'inclusiveValidToOf(x)', "x::daterange", "'[)'"]) {
      expect(PROIBIDO.test(ruim)).toBe(true);
    }
  });

  it('nenhum arquivo de src, fora de dateRangeWire.ts, converte daterange', () => {
    const achados = todas
      .filter((f) => !f.endsWith(DONO))
      .filter((f) => PROIBIDO.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f))
      .filter((f) => !INTERINIDADE_056.includes(f));
    expect(achados).toEqual([]);
  });

  it('a interinidade da 056 só lista arquivos que ainda casam o padrão (lista velha não esconde nada)', () => {
    for (const rel of INTERINIDADE_056) {
      const full = path.join(SRC, rel);
      if (fs.existsSync(full)) expect(PROIBIDO.test(fs.readFileSync(full, 'utf8'))).toBe(true);
    }
  });
});
