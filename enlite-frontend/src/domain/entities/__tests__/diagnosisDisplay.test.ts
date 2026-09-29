import { describe, it, expect } from 'vitest';
import { sortDiagnosesForCard, diagnosisDisplayState } from '../diagnosisDisplay';
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

// ── diagnosisDisplayState ───────────────────────────────────────────────────
// Os três estados existem porque colapsá-los faz a tela MENTIR sobre o paciente:
// "não consegui ler" virando "não tem diagnóstico" é o defeito que isto impede.
describe('diagnosisDisplayState', () => {
  const dx = (over: Partial<PatientDiagnosisDetail> = {}): PatientDiagnosisDetail => ({
    id: 'dx-1',
    uri: 'http://id.who.int/icd/entity/111111',
    title: 'Hipertensión esencial',
    isPrimary: true,
    source: 'PANEL',
    active: true,
    ...over,
  });

  it('lista os ativos, principal primeiro', () => {
    const state = diagnosisDisplayState(
      [dx({ id: 'b', title: 'Asma', isPrimary: false }), dx({ id: 'a' })],
      false,
    );
    expect(state.kind).toBe('list');
    if (state.kind !== 'list') throw new Error('esperava list');
    expect(state.diagnoses.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('array vazio é "empty"', () => {
    expect(diagnosisDisplayState([], false).kind).toBe('empty');
  });

  it('null é "noPermission" — NUNCA "empty"', () => {
    expect(diagnosisDisplayState(null, false).kind).toBe('noPermission');
  });

  it('unavailable tem precedência sobre tudo', () => {
    expect(diagnosisDisplayState(null, true).kind).toBe('unavailable');
    expect(diagnosisDisplayState([], true).kind).toBe('unavailable');
    expect(diagnosisDisplayState([dx()], true).kind).toBe('unavailable');
  });

  it('diagnóstico inativo não aparece', () => {
    expect(diagnosisDisplayState([dx({ active: false })], false).kind).toBe('empty');
  });
});
