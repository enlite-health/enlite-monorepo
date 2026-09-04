import { describe, it, expect } from 'vitest';
import { sortDiagnosesForCard } from '../diagnosisDisplay';
import type { PatientDiagnosisDetail } from '../PatientDetail';

function d(over: Partial<PatientDiagnosisDetail>): PatientDiagnosisDetail {
  return {
    id: over.id ?? 'id',
    uri: 'http://id.who.int/icd/release/11/2026-01/mms/1',
    title: over.title ?? 'Zeta',
    isPrimary: over.isPrimary ?? false,
    source: over.source ?? 'PANEL',
    active: over.active ?? true,
    ...over,
  };
}

describe('sortDiagnosesForCard', () => {
  it('filtra os inativos fora', () => {
    const out = sortDiagnosesForCard([d({ id: 'a', active: false }), d({ id: 'b', active: true })]);
    expect(out.map((x) => x.id)).toEqual(['b']);
  });

  it('principal vem antes do não-principal', () => {
    const out = sortDiagnosesForCard([
      d({ id: 'a', title: 'Alfa', isPrimary: false }),
      d({ id: 'b', title: 'Beta', isPrimary: true }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('dois principais de origens diferentes: PANEL vence CLICKUP', () => {
    const out = sortDiagnosesForCard([
      d({ id: 'clickup', isPrimary: true, source: 'CLICKUP' }),
      d({ id: 'panel', isPrimary: true, source: 'PANEL' }),
    ]);
    expect(out[0].id).toBe('panel');
  });

  it('dois principais da MESMA origem (empate de precedência): desempata por título', () => {
    const out = sortDiagnosesForCard([
      d({ id: 'z', isPrimary: true, source: 'PANEL', title: 'Zeta' }),
      d({ id: 'a', isPrimary: true, source: 'PANEL', title: 'Alfa' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['a', 'z']);
  });

  it('origem desconhecida (fora do mapa de precedência) cai no fallback e não quebra', () => {
    const out = sortDiagnosesForCard([
      d({ id: 'known', isPrimary: true, source: 'PANEL', title: 'B' }),
      d({ id: 'unknown', isPrimary: true, source: 'ALIEN', title: 'A' }),
    ]);
    expect(out[0].id).toBe('known');
  });

  it('sem nenhum principal, ordena só por título', () => {
    const out = sortDiagnosesForCard([d({ id: 'z', title: 'Zeta' }), d({ id: 'a', title: 'Alfa' })]);
    expect(out.map((x) => x.id)).toEqual(['a', 'z']);
  });

  it('não muta o array de entrada', () => {
    const input = [d({ id: 'a' })];
    sortDiagnosesForCard(input);
    expect(input).toHaveLength(1);
  });
});
