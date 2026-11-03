import { detectAnomalies } from '../detectAnomalies';
import type { DailyCostPoint } from '../types';

const LATEST = '2026-10-20';

/** 7 dias de histórico (13..19/10) com `base` + o dia mais recente com `latest`, para um serviço sintético. */
function series(base: number, latest: number, name = 'svc-a', histDays = 7): DailyCostPoint[] {
  const out: DailyCostPoint[] = [];
  for (let i = 0; i < histDays; i++) {
    out.push({ kind: 'service', name, day: `2026-10-${String(19 - i).padStart(2, '0')}`, value: base });
  }
  out.push({ kind: 'service', name, day: LATEST, value: latest });
  return out;
}

describe('detectAnomalies (CA-6)', () => {
  it('dia = 2,1x a mediana e +11 -> anomalia com fator e mediana', () => {
    const r = detectAnomalies(series(10, 21), LATEST);
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ kind: 'service', name: 'svc-a', dayValue: 21, median7: 10, isNew: false });
    expect(r.items[0].factor).toBeCloseTo(2.1);
  });

  it('exatamente 2x e +6 (limites inclusivos) -> anomalia', () => {
    const r = detectAnomalies(series(6, 12), LATEST);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].factor).toBe(2);
  });

  it('1,9x a mediana (+9) -> não é anomalia', () => {
    const r = detectAnomalies(series(10, 19), LATEST);
    expect(r.status).toBe('ok');
    expect(r.items).toEqual([]);
  });

  it('fator ok mas diferença < 5 (3x, +2) -> não é anomalia', () => {
    expect(detectAnomalies(series(1, 3), LATEST).items).toEqual([]);
  });

  it('menos de 7 dias de dado -> histórico insuficiente, sem itens', () => {
    const r = detectAnomalies(series(10, 100, 'svc-a', 6), LATEST);
    expect(r).toEqual({ status: 'insufficient_history', items: [] });
  });

  it('sem dia completo (null) -> histórico insuficiente', () => {
    expect(detectAnomalies(series(10, 100), null).status).toBe('insufficient_history');
  });

  it('serviço novo (sem custo na janela) sai marcado "novo", sem fator; abaixo da diferença mínima não aparece', () => {
    const pts = [...series(10, 10), { kind: 'service' as const, name: 'svc-new', day: LATEST, value: 8 },
      { kind: 'service' as const, name: 'svc-tiny', day: LATEST, value: 1 }];
    const r = detectAnomalies(pts, LATEST);
    expect(r.items).toEqual([{ kind: 'service', name: 'svc-new', dayValue: 8, median7: 0, factor: null, isNew: true }]);
  });

  it('ordena pela diferença e separa serviço de recurso', () => {
    const pts = [
      ...series(10, 30, 'a'),
      ...series(10, 50, 'b'),
      ...series(10, 25, 'r1').map((p) => ({ ...p, kind: 'resource' as const })),
    ];
    const r = detectAnomalies(pts, LATEST);
    expect(r.items.map((i) => `${i.kind}:${i.name}`)).toEqual(['service:b', 'service:a', 'resource:r1']);
  });
});
