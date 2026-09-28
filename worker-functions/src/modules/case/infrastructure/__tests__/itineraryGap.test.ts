/**
 * DX-11.4 — a folga entre endereços diferentes mora num lugar só: a função SQL
 * `itinerary_min_gap_minutes()` (migration 482). O TypeScript nunca guarda esse
 * número — o 409 lê o `DETAIL` que a própria trava monta. Este teste lê a
 * migration como TEXTO (é unit, não toca o banco) e prova:
 *   (a) existe exatamente 1 definição da função da folga;
 *   (b) o corpo dela devolve o inteiro certo, lido do `SELECT <n>` — nunca em
 *       segundos nem por multiplicação;
 *   (c) a trava chama essa função e não duplica o inteiro em minutos em
 *       nenhum outro ponto do próprio corpo (a conversão de segundos-por-minuto
 *       usada para ler `start_time`/`end_time` não conta — é uma constante de
 *       unidade, não a folga).
 * O banco real prova o valor em produção (P3, `SELECT itinerary_min_gap_minutes()`).
 */
import fs from 'fs';
import path from 'path';

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../../../migrations/482_patient_itinerary_assembly_and_overlap.sql',
);

describe('itinerary_min_gap_minutes() — a folga mora num lugar só (DX-11.4)', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  it('existe exatamente 1 definição da função da folga', () => {
    const defs = sql.match(/CREATE OR REPLACE FUNCTION itinerary_min_gap_minutes\(\)/g) ?? [];
    expect(defs).toHaveLength(1);
  });

  it('o corpo da função devolve o inteiro lido do SELECT, nunca em segundos ou por multiplicação', () => {
    const fnMatch = sql.match(
      /CREATE OR REPLACE FUNCTION itinerary_min_gap_minutes\(\)[\s\S]*?AS \$\$\s*SELECT\s+(\d+)\s*\$\$;/,
    );
    expect(fnMatch).not.toBeNull();
    const literal = fnMatch![1];
    // o critério 11 exige o inteiro escrito como está no banco — nunca o equivalente em segundos nem um produto.
    expect(literal).toBe('60');
    expect(Number(literal)).toBe(60);
  });

  it('a trava chama a função da folga e não duplica o inteiro em minutos no próprio corpo', () => {
    const trigMatch = sql.match(
      /CREATE OR REPLACE FUNCTION fn_patient_itinerary_assignment_no_overlap\(\)[\s\S]*?\n\$\$;/,
    );
    expect(trigMatch).not.toBeNull();
    const body = trigMatch![0];

    expect(body).toContain('itinerary_min_gap_minutes()');

    // Todo `60` bruto no corpo da trava, fora da conversão de segundos-por-minuto
    // (sempre escrita como `/ 60`, uma constante de UNIDADE — não a folga), seria
    // uma 2ª definição escondida da folga. A única fonte é a função acima.
    const occurrences = [...body.matchAll(/\b60\b/g)];
    const suspicious = occurrences.filter((m) => {
      const idx = m.index ?? 0;
      const before = body.slice(Math.max(0, idx - 4), idx);
      return !/\/\s*$/.test(before);
    });
    expect(suspicious).toHaveLength(0);
  });
});
