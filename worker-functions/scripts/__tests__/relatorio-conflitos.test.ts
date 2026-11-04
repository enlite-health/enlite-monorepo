/**
 * relatorio-conflitos.test.ts — spec 058 Parte A, T031: o relatório Q1–Q6 do P2(A).
 *
 * Unit puro (sem Postgres: o job de unit do CI não tem banco). O comportamento das queries contra dados reais é provado em
 * `tests/e2e/058a-seed-e-backfill.e2e.test.ts` ("relatório Q1–Q6 contra Postgres"); aqui se prova a FORMA que não pode regredir:
 * N(x) nos dois lados, Q4 só com ordinal 1 + source 'clickup', mapa rate() só no script, saída só com contagem.
 *   `-t "Q5 normaliza os dois lados"` é a linha SABOTAGEM da T031.
 */
import { CONSULTAS, N, RATE_SQL, dataLocal, executarRelatorio, sqlConflitoTexto } from '../relatorio-conflitos-p2a';

const q = (id: string): string => CONSULTAS.find((c) => c.id === id)!.sql;
const ocorrencias = (texto: string, trecho: string): number => texto.split(trecho).length - 1;

describe('relatório de conflitos do P2(A) — Q1 a Q6', () => {
  it('as 6 queries existem, na ordem Q1..Q6, e só devolvem contagem', () => {
    expect(CONSULTAS.map((c) => c.id)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']);
    for (const c of CONSULTAS) {
      expect(c.sql).toMatch(/^SELECT count\(\*\)::int AS n FROM /);
      expect(c.sql).not.toMatch(/SELECT\s+(p|s)\.(id|first_name|last_name|health_insurance|insurance_|affiliate)/);
    }
  });

  it('N(x) é NULLIF(NULLIF(lower(btrim(x)), ""), "null") — o mesmo do backfill 539', () => {
    expect(N('x')).toBe("NULLIF(NULLIF(lower(btrim(x)), ''), 'null')");
  });

  it('Q5 normaliza os dois lados: N(health_insurance_name) e N(insurance_informed) na mesma comparação', () => {
    const sql = q('Q5');
    expect(sql).toContain(`${N('p.health_insurance_name')} IS DISTINCT FROM ${N('p.insurance_informed')}`);
    expect(ocorrencias(sql, N('p.health_insurance_name'))).toBe(2); // NOT NULL e DISTINCT FROM
    expect(ocorrencias(sql, N('p.insurance_informed'))).toBe(1);
  });

  it('Q6 normaliza os dois lados: N(health_insurance_member_id) e N(affiliate_id)', () => {
    const sql = q('Q6');
    expect(sql).toContain(`${N('p.health_insurance_member_id')} IS DISTINCT FROM ${N('p.affiliate_id')}`);
    expect(ocorrencias(sql, N('p.health_insurance_member_id'))).toBe(2);
    expect(ocorrencias(sql, N('p.affiliate_id'))).toBe(1);
  });

  it('o construtor sqlConflitoTexto aplica N() ao legado E ao dono (nunca só a um lado)', () => {
    const sql = sqlConflitoTexto('p.a', 'p.b');
    expect(sql).toContain(`${N('p.a')} IS DISTINCT FROM ${N('p.b')}`);
  });

  it('Q4 compara com o raw_label do ordinal 1 e source = clickup (linhas admin_manual não entram), com N() nos dois lados', () => {
    const sql = q('Q4');
    expect(sql).toContain('v.ordinal = 1');
    expect(sql).toContain("v.source = 'clickup'");
    expect(sql).toContain('FROM patient_insurance_verified v');
    expect(sql).toContain(`${N('p.insurance_verified')} IS DISTINCT FROM`);
    expect(ocorrencias(sql, "NULLIF(NULLIF(lower(btrim(")).toBe(3); // legado ×2 (NOT NULL e DISTINCT) + raw_label ×1
  });

  it('nenhuma query filtra deleted_at (o C-F e o P2 olham todas as linhas)', () => {
    for (const c of CONSULTAS) expect(c.sql).not.toMatch(/deleted_at/);
  });

  it('Q1–Q3 leem só vínculo VIVO e termo VIGENTE na data local do país do serviço', () => {
    for (const id of ['Q1', 'Q2', 'Q3']) {
      const sql = q(id);
      expect(sql).toContain('l.superseded_at IS NULL');
      expect(sql).toContain('t.superseded_at IS NULL');
      expect(sql).toContain('l.valid @>');
      expect(sql).toContain('t.valid @>');
      expect(sql).toContain("CASE s.country WHEN 'AR' THEN $1::date WHEN 'BR' THEN $2::date END");
    }
  });

  it('rate() vive só no script: IVA_EXEMPT=0, IVA_10_5=10.5, IVA_21=21 (e só em Q2)', () => {
    expect(RATE_SQL).toBe("CASE s.tax_condition WHEN 'IVA_EXEMPT' THEN 0 WHEN 'IVA_10_5' THEN 10.5 WHEN 'IVA_21' THEN 21 END");
    expect(q('Q2')).toContain(RATE_SQL);
    for (const id of ['Q1', 'Q3', 'Q4', 'Q5', 'Q6']) expect(q(id)).not.toContain('IVA_');
  });

  it('dataLocal usa o fuso do país: 02:30 UTC de 20/10 ainda é 19/10 em Buenos Aires e em São Paulo', () => {
    const instante = new Date('2026-10-20T02:30:00Z');
    expect(dataLocal('AR', instante)).toBe('2026-10-19');
    expect(dataLocal('BR', instante)).toBe('2026-10-19');
    expect(dataLocal('AR', new Date('2026-10-20T04:00:00Z'))).toBe('2026-10-20'); // controle: cruzou a meia-noite local
  });

  it('executarRelatorio roda numa transação READ ONLY, passa as datas só às queries com asof e devolve só contagens', async () => {
    const chamadas: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        chamadas.push({ sql, params });
        return { rows: [{ n: 3 }] };
      }),
      release: jest.fn(),
    };
    const linhas = await executarRelatorio({ connect: async () => client } as never, { ar: '2026-10-19', br: '2026-10-19' });
    expect(chamadas[0].sql).toBe('BEGIN READ ONLY');
    expect(chamadas[chamadas.length - 1].sql).toBe('ROLLBACK');
    expect(linhas).toHaveLength(6);
    expect(linhas.every((l) => l.conflitos === 3)).toBe(true);
    expect(Object.keys(linhas[0]).sort()).toEqual(['conflitos', 'id', 'titulo']);
    const comAsof = chamadas.filter((c) => c.params && c.params.length === 2);
    expect(comAsof).toHaveLength(3); // Q1, Q2, Q3
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
