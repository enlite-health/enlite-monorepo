/**
 * vacancyLifecycle — a tabela do ciclo de vida é o dono (estado-automatico-do-paciente, F2, D3/E5).
 * Lê o CHECK da migration 483 do arquivo: valor novo no CHECK sem linha na tabela reprova aqui.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CICLO_POR_STATUS, CICLOS_DE_VIDA, STATUS_GRAVAVEIS, VACANCY_STATUS_VALUES,
  cicloDeVidaDaVaga, cicloDeVidaSql, isStatusGravavel, statusDeRetomada,
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

  it.each<[VacancyStatusValue, string]>([
    ['SEARCHING', 'aberta'], ['SEARCHING_REPLACEMENT', 'aberta'], ['RAPID_RESPONSE', 'aberta'],
    ['ACTIVE', 'aberta'], ['PENDING_ACTIVATION', 'aberta'], ['ON_HOLD', 'pausada'],
    ['SUSPENDED', 'pausada'], ['CLOSED', 'cerrada'], ['DE_BAJA', 'baja'],
  ])('%s publicada é %s', (status, ciclo) => {
    expect(cicloDeVidaDaVaga({ status, isDraft: false })).toBe(ciclo);
  });

  it('is_draft manda: rascunho em qualquer status, inclusive o legado', () => {
    for (const status of VACANCY_STATUS_VALUES) expect(cicloDeVidaDaVaga({ status, isDraft: true })).toBe('rascunho');
  });

  it('o legado SEARCHING_REPLACEMENT publicado é lido como "aberta" (spec: linha antiga com valor legado)', () => {
    expect(cicloDeVidaDaVaga({ status: 'SEARCHING_REPLACEMENT', isDraft: false })).toBe('aberta');
  });

  it('o SQL gerado cobre os 9 valores do CHECK, em um único ciclo cada, e o rascunho vem primeiro', () => {
    const sql = cicloDeVidaSql('jp');
    expect(sql.startsWith(`(CASE WHEN jp.is_draft IS TRUE THEN 'rascunho'`)).toBe(true);
    for (const s of valoresDoCheck()) expect(sql.match(new RegExp(`'${s}'`, 'g'))).toHaveLength(1);
    for (const c of CICLOS_DE_VIDA) expect(sql).toContain(`'${c}'`);
  });

  it('STATUS_GRAVAVEIS são exatamente os 4 do ciclo (E5) e o legado não é gravável', () => {
    expect([...STATUS_GRAVAVEIS]).toEqual(['SEARCHING', 'ON_HOLD', 'SUSPENDED', 'CLOSED']);
    for (const legado of ['SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'ACTIVE', 'PENDING_ACTIVATION', 'DE_BAJA']) {
      expect(isStatusGravavel(legado)).toBe(false);
    }
  });

  it('E8: "Reanudar" de pausa que veio de valor legado grava SEARCHING; sem registro, SEARCHING', () => {
    expect(statusDeRetomada('SEARCHING_REPLACEMENT')).toBe('SEARCHING');
    expect(statusDeRetomada('RAPID_RESPONSE')).toBe('SEARCHING');
    expect(statusDeRetomada(null)).toBe('SEARCHING');
    expect(statusDeRetomada('VALOR_FORA_DA_TABELA')).toBe('SEARCHING');
    expect(statusDeRetomada('CLOSED')).toBe('CLOSED');
  });

  it('zero `if` no arquivo do dono', () => {
    const fonte = readFileSync(join(__dirname, '../vacancyLifecycle.ts'), 'utf8');
    expect(fonte.match(/\bif \(/g)).toBeNull();
  });
});
