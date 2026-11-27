/**
 * vacancyLifecycle — a tabela do selo é o dono (semaforo-da-vaga F4: o selo encolheu para `rascunho | baja | null`).
 * Lê o CHECK da migration 483 do arquivo: valor novo no CHECK sem linha na tabela reprova aqui.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CICLO_POR_STATUS, CICLOS_DE_VIDA, STATUS_GRAVAVEIS, VACANCY_STATUS_VALUES,
  cicloDeVidaDaVaga, cicloDeVidaSql, isCicloDeVida,
  type VacancyStatusValue,
} from '../vacancyLifecycle';

const MIGRATION_483 = join(__dirname, '../../../../../migrations/483_job_postings_de_baja.sql');

function valoresDoCheck(): string[] {
  const sql = readFileSync(MIGRATION_483, 'utf8');
  const bloco = /ADD CONSTRAINT job_postings_status_check\s+CHECK \(status IN \(([^)]*)\)\)/.exec(sql);
  expect(bloco).not.toBeNull(); // contagem zero é falha: o regex TEM de achar o CHECK
  return [...bloco![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
}

describe('vacancyLifecycle — tabela × CHECK da 483', () => {
  it('cada valor do CHECK vivo tem linha na tabela, e a tabela não tem valor que o CHECK não tenha', () => {
    const check = valoresDoCheck();
    expect(check.length).toBe(9);
    expect([...check].sort()).toEqual([...VACANCY_STATUS_VALUES].sort());
    expect(Object.keys(CICLO_POR_STATUS).sort()).toEqual([...check].sort());
  });

  it.each<[VacancyStatusValue, string | null]>([
    ['SEARCHING', null], ['SEARCHING_REPLACEMENT', null], ['RAPID_RESPONSE', null],
    ['ACTIVE', null], ['PENDING_ACTIVATION', null], ['ON_HOLD', null],
    ['SUSPENDED', null], ['CLOSED', null], ['DE_BAJA', 'baja'],
  ])('%s publicada tem selo %s (só a baixa tem selo; o legado pausado/fechado fica sem selo, D6)', (status, ciclo) => {
    expect(cicloDeVidaDaVaga({ status, isDraft: false })).toBe(ciclo);
  });

  it('is_draft manda: rascunho em qualquer status, inclusive o legado', () => {
    for (const status of VACANCY_STATUS_VALUES) expect(cicloDeVidaDaVaga({ status, isDraft: true })).toBe('rascunho');
  });

  it('o selo tem exatamente 2 marcadores, e `aberta|pausada|cerrada` não são mais ciclo (o filtro os recusa)', () => {
    expect([...CICLOS_DE_VIDA]).toEqual(['rascunho', 'baja']);
    for (const velho of ['aberta', 'pausada', 'cerrada']) expect(isCicloDeVida(velho)).toBe(false);
    for (const novo of CICLOS_DE_VIDA) expect(isCicloDeVida(novo)).toBe(true);
  });

  it('o SQL gerado: rascunho primeiro, só `DE_BAJA` vira baja, o resto cai em NULL (sem selo)', () => {
    const sql = cicloDeVidaSql('jp');
    expect(sql.startsWith(`(CASE WHEN jp.is_draft IS TRUE THEN 'rascunho'`)).toBe(true);
    expect(sql).toContain(`WHEN jp.status IN ('DE_BAJA') THEN 'baja'`);
    for (const s of valoresDoCheck().filter((v) => v !== 'DE_BAJA')) expect(sql).not.toContain(`'${s}'`);
    for (const velho of ['aberta', 'pausada', 'cerrada']) expect(sql).not.toContain(`'${velho}'`);
  });

  it('STATUS_GRAVAVEIS é vazio: o cliente não grava estado nenhum', () => {
    expect([...STATUS_GRAVAVEIS]).toEqual([]);
  });

  it('zero `if` no arquivo do dono', () => {
    const fonte = readFileSync(join(__dirname, '../vacancyLifecycle.ts'), 'utf8');
    expect(fonte.match(/\bif \(/g)).toBeNull();
  });
});
