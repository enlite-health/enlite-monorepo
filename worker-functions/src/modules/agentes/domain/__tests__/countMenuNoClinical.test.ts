/**
 * countMenuNoClinical — change 085, spec §6: o cardapio de contagem da Maria e os leitores NAO tocam campo clinico.
 * Grep estatico dos arquivos da contagem: 0 casamentos de /clinical|diagn/i. AUTOTESTE no mesmo arquivo: a regex casa uma string
 * plantada e a lista de arquivos lidos e > 0 (contagem zero nao pode significar "nao li").
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const RAIZ = join(__dirname, '..', '..');
const CLINICO = /clinical|diagn/i;

const ARQUIVOS: string[] = [
  join(RAIZ, 'domain', 'assistantCountMenu.ts'),
  join(RAIZ, 'domain', 'countRequestValidation.ts'),
  ...readdirSync(join(RAIZ, 'infrastructure'))
    .filter((f) => /CountReader\.ts$/.test(f))
    .map((f) => join(RAIZ, 'infrastructure', f)),
  join(RAIZ, 'application', 'AssistantCountService.ts'),
];

describe('contagem da Maria — nenhum termo clinico no cardapio, validacao, leitores e servico', () => {
  it('autoteste: a regex casa string plantada e a lista de arquivos nao e vazia (esperados: 3 leitores + 3 arquivos fixos)', () => {
    expect(CLINICO.test('patient_clinical')).toBe(true);
    expect(CLINICO.test('Diagnostico')).toBe(true);
    expect(CLINICO.test('stage')).toBe(false);
    expect(ARQUIVOS.length).toBeGreaterThan(0);
    expect(ARQUIVOS.filter((f) => /CountReader\.ts$/.test(f))).toHaveLength(3);
    for (const f of ARQUIVOS) expect(readFileSync(f, 'utf8').length).toBeGreaterThan(100);
  });

  it.each(ARQUIVOS.map((f) => [f.slice(RAIZ.length + 1), f]))('%s: 0 casamentos de /clinical|diagn/i', (_nome, f) => {
    const linhas = readFileSync(f, 'utf8').split('\n');
    const achados = linhas.map((l, i) => (CLINICO.test(l) ? `${i + 1}: ${l.trim()}` : null)).filter(Boolean);
    expect(achados).toEqual([]);
  });
});
