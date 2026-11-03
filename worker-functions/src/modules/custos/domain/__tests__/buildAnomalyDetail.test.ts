import { ANOMALY_SERIES_OUT_DAYS, DETAIL_RESOURCES_MAX, buildAnomalyDetail, buildSeries } from '../buildAnomalyDetail';
import type { AnomalyDetailRow, DailyCostPoint } from '../types';

const DAY = '2026-10-20';
const d = (n: number) => `2026-10-${String(n).padStart(2, '0')}`;

/** `resource` com `hist` nos dias 13..19 (a janela de 7 dias) e `latest` no dia 20. `hist = null` = sem linha na janela. */
function res(service: string, resource: string, hist: number | null, latest: number): AnomalyDetailRow[] {
  const rows: AnomalyDetailRow[] = [];
  if (hist !== null) for (let n = 13; n <= 19; n++) rows.push({ day: d(n), service, resource, value: hist });
  rows.push({ day: DAY, service, resource, value: latest });
  return rows;
}

describe('buildSeries (CA-15, series)', () => {
  const pts: DailyCostPoint[] = [
    ...[10, 11, 12, 13, 14, 16, 17, 18, 19, 20].map((n) => ({ kind: 'service' as const, name: 'A', day: d(n), value: n })),
    { kind: 'service', name: 'A', day: d(20), value: 100 }, // 2ª linha do mesmo dia: soma
    { kind: 'resource', name: 'A', day: d(15), value: 999 }, // outro kind com o mesmo nome: ignorado
    { kind: 'service', name: 'B', day: d(15), value: 999 }, // outro nome: ignorado
  ];

  it('14 pontos terminando em `day`, dia sem linha = 0, linhas do mesmo dia somadas, outro kind/nome ignorado', () => {
    const s = buildSeries(pts, 'service', 'A', DAY);
    expect(s).toHaveLength(ANOMALY_SERIES_OUT_DAYS);
    expect(s[0]).toEqual({ day: d(7), value: 0 });
    expect(s[13]).toEqual({ day: DAY, value: 120 });
    expect(s.map((p) => p.value)).toEqual([0, 0, 0, 10, 11, 12, 13, 14, 0, 16, 17, 18, 19, 120]);
  });

  it('item sem nenhuma linha -> 14 zeros (nunca série vazia)', () => {
    const s = buildSeries(pts, 'service', 'inexistente', DAY);
    expect(s).toHaveLength(14);
    expect(s.every((p) => p.value === 0)).toBe(true);
  });
});

describe('buildAnomalyDetail (CA-15, detail)', () => {
  // Serviço A: 14 recursos. Deltas (dia 20 − mediana): r1 10 · r2 3 · r14 1,4 · r13 1,3 · r12 1,2 · r11 1,1 · __none__ 1,05 · r10 1,0 · r9 0,9 · r8 0,8 (os 10 que entram)
  // · r7 0,7 · r6 0,6 · r5 0,5 · r3 0 (cortados). r3 tem o MAIOR valor do dia (20): ordenar por dayValue o poria em 1º.
  const rowsA: AnomalyDetailRow[] = [
    ...res('A', 'r1', 2, 12), ...res('A', 'r2', 5, 8), ...res('A', 'r3', 20, 20), ...res('A', '__none__', null, 1.05),
    ...[5, 6, 7, 8, 9, 10, 11, 12, 13, 14].flatMap((i) => res('A', `r${i}`, null, i / 10)),
  ];
  const rowsB = res('B', 'b1', 1, 1000); // outro serviço: não pode vazar para o detalhe de A
  const out = buildAnomalyDetail([...rowsA, ...rowsB], DAY, ['A', 'B', 'C']);

  it('recursos ordenados pelo AUMENTO (dayValue − mediana) e cortados em 10; o de maior valor mas sem aumento sai', () => {
    const a = out.get('A')!;
    expect(a.resources).toHaveLength(DETAIL_RESOURCES_MAX);
    expect(a.resources.map((r) => r.resource)).toEqual(['r1', 'r2', 'r14', 'r13', 'r12', 'r11', '__none__', 'r10', 'r9', 'r8']);
    expect(a.resources.map((r) => r.resource)).not.toContain('r3');
  });

  it('cada recurso traz dayValue, mediana dos 7 dias anteriores (zero se sem linha) e total do mês até o dia', () => {
    const [r1, r2] = out.get('A')!.resources;
    expect(r1).toEqual({ resource: 'r1', dayValue: 12, median7: 2, monthTotal: 7 * 2 + 12 });
    expect(r2).toEqual({ resource: 'r2', dayValue: 8, median7: 5, monthTotal: 7 * 5 + 8 });
    const none = out.get('A')!.resources.find((r) => r.resource === '__none__')!;
    expect(none).toEqual({ resource: '__none__', dayValue: 1.05, median7: 0, monthTotal: 1.05 });
  });

  it('monthSeries: dia 1 até o dia da anomalia (20 pontos), soma dos recursos do serviço, dia sem linha = 0', () => {
    const m = out.get('A')!.monthSeries;
    expect(m).toHaveLength(20);
    expect(m[0]).toEqual({ day: d(1), value: 0 });
    expect(m[19].day).toBe(DAY);
    // dia 15 = r1 2 + r2 5 + r3 20 = 27 (os outros não têm linha ali); dia 20 = soma de todos os dayValue de A
    expect(m[14]).toEqual({ day: d(15), value: 27 });
    const day20 = 12 + 8 + 20 + 1.05 + [5, 6, 7, 8, 9, 10, 11, 12, 13, 14].reduce((s, i) => s + i / 10, 0);
    expect(m[19].value).toBeCloseTo(day20, 10);
  });

  it('serviço B só vê as próprias linhas; serviço pedido sem linha -> série de zeros e nenhum recurso', () => {
    expect(out.get('B')!.resources).toEqual([{ resource: 'b1', dayValue: 1000, median7: 1, monthTotal: 7 + 1000 }]);
    expect(out.get('C')).toEqual({ monthSeries: Array.from({ length: 20 }, (_, i) => ({ day: d(i + 1), value: 0 })), resources: [] });
  });

  it('dia 3 do mês: a mediana usa dias do mês anterior, a série do mês só os do mês', () => {
    const rows: AnomalyDetailRow[] = [
      { day: '2026-09-26', service: 'A', resource: 'r', value: 4 }, { day: '2026-09-27', service: 'A', resource: 'r', value: 4 },
      { day: '2026-09-28', service: 'A', resource: 'r', value: 4 }, { day: '2026-09-29', service: 'A', resource: 'r', value: 4 },
      { day: '2026-09-30', service: 'A', resource: 'r', value: 4 }, { day: '2026-10-01', service: 'A', resource: 'r', value: 4 },
      { day: '2026-10-02', service: 'A', resource: 'r', value: 4 }, { day: '2026-10-03', service: 'A', resource: 'r', value: 40 },
    ];
    const a = buildAnomalyDetail(rows, '2026-10-03', ['A']).get('A')!;
    expect(a.resources[0]).toEqual({ resource: 'r', dayValue: 40, median7: 4, monthTotal: 4 + 4 + 40 });
    expect(a.monthSeries.map((p) => p.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });
});
