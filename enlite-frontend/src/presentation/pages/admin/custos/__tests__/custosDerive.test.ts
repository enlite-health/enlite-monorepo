import { describe, it, expect } from 'vitest';
import type { CostAnomalyItem } from '@infrastructure/http/AdminCostsApiService';
import { impact, increase, restOfTotal, sharePct, shareOfIncrease, splitAnomalies, topContributor } from '../custosDerive';
import { daysInMonth, formatDay, formatFactor, formatPercent, monthLabel, monthName } from '../custosFormat';

const geocoding: CostAnomalyItem = {
  kind: 'service', name: 'Geocoding API', dayValue: 41.2, median7: 3.1, factor: 13.3, isNew: false, series: [],
  detail: {
    monthSeries: [],
    resources: [
      { resource: 'clickup-patient-sync-safety-net-job', dayValue: 35.35, median7: 0.3, monthTotal: 55.65 },
      { resource: 'enlite-triage-service-prd', dayValue: 2.8, median7: 0.9, monthTotal: 16.98 },
    ],
  },
};
const novo: CostAnomalyItem = { kind: 'resource', name: 'x', dayValue: 6.4, median7: 0, factor: null, isNew: true, series: [] };

describe('custosDerive (exemplo do A1/A2)', () => {
  it('impacto = 41,20 − 3,10 = 38,10 e aumento do recurso = 35,05', () => {
    expect(impact(geocoding)).toBeCloseTo(38.1, 6);
    expect(increase(geocoding.detail!.resources[0])).toBeCloseTo(35.05, 6);
  });
  it('parte do aumento = 35,05 ÷ 38,10 = 92,0% (o número do mockup)', () => {
    const pct = shareOfIncrease(geocoding.detail!.resources[0], impact(geocoding));
    expect(formatPercent(pct, 'pt-BR')).toBe('92,0%');
    expect(topContributor(geocoding)).toMatchObject({ resource: 'clickup-patient-sync-safety-net-job' });
    expect(topContributor(geocoding)!.pct).toBeCloseTo(92.0, 1);
  });
  it('aumento negativo vale 0% e impacto ≤ 0 não divide por zero', () => {
    expect(shareOfIncrease({ dayValue: 1, median7: 5 }, 38.1)).toBe(0);
    expect(shareOfIncrease({ dayValue: 9, median7: 1 }, 0)).toBe(0);
  });
  it('sem detail não há maior contribuinte', () => {
    expect(topContributor(novo)).toBeNull();
  });
  it('participação e "demais": total do mês ≤ 0 dá 0; resíduo de centavo não vira linha', () => {
    expect(sharePct(412.3, 1148.4)).toBeCloseTo(35.9, 1);
    expect(sharePct(5, 0)).toBe(0);
    expect(restOfTotal(100, 59.5)).toBeCloseTo(40.5, 6);
    expect(restOfTotal(100, 99.998)).toBe(0);
    expect(restOfTotal(100, 100.4)).toBe(0);
  });
  it('destaque = 1º item que não é novo; o resto fica compacto, na ordem', () => {
    expect(splitAnomalies([novo, geocoding])).toEqual({ main: geocoding, others: [novo] });
    expect(splitAnomalies([novo]).main).toBeNull();
  });
});

describe('custosFormat novos', () => {
  it('dias, fator, mês', () => {
    expect(formatDay('2026-10-17')).toBe('17/10');
    expect(formatDay('2026-10-17', 'long')).toBe('17/10/2026');
    expect(formatDay(null)).toBe('');
    expect(formatFactor(13.3, 'pt-BR')).toBe('13,3×');
    expect(daysInMonth('2026-10')).toBe(31);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(monthName('2026-10', 'pt-BR')).toBe('outubro');
    expect(monthLabel('2026-10', 'es')).toBe('octubre de 2026');
  });
});
