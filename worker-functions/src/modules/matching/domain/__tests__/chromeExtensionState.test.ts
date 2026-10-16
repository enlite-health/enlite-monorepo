/**
 * spec 050 F15 (R-1, R-2) — a função pura que vira o relatório do Chrome em UM dos 4 estados.
 * Cada teste MORRE se a regra correspondente for desfeita (sabotagens no relatório da fase).
 */
import { classifyExtension, isConclusive, REPORT_MAX_AGE_HOURS } from '../chromeExtensionState';
import type { ChromeProfileReport } from '../../application/ports/ChromeReportPort';

const EXT = 'ext-sintetica';
const NOW = new Date('2026-10-11T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);
const profile = (ageH: number | null, extensions: ChromeProfileReport['extensions']): ChromeProfileReport => ({
  lastStatusReportTime: ageH === null ? null : hoursAgo(ageH),
  extensions,
});
const classify = (p: ChromeProfileReport | null, inInstalledList = false) =>
  classifyExtension({ profile: p, inInstalledList, extensionId: EXT, now: NOW });

describe('classifyExtension (A15-1: os 4 estados)', () => {
  it('instalada: relatório fresco com a extensão ativa; relatorio_de = o lastStatusReportTime', () => {
    const p = profile(2, [{ extensionId: EXT, isDisabled: false }]);
    expect(classify(p, true)).toEqual({ state: 'instalada', reportAt: p.lastStatusReportTime });
  });

  it('desativada: a extensão está no perfil mas isDisabled', () => {
    expect(classify(profile(2, [{ extensionId: EXT, isDisabled: true }]), true).state).toBe('desativada');
  });

  it('ausente: relatório fresco, a extensão não está no perfil nem na lista (outras extensões não contam)', () => {
    expect(classify(profile(2, [{ extensionId: 'outra', isDisabled: false }])).state).toBe('ausente');
    expect(classify(profile(2, [])).state).toBe('ausente');
  });

  it('sem_relatorio: sem perfil, ou perfil que nunca reportou', () => {
    expect(classify(null)).toEqual({ state: 'sem_relatorio', reportAt: null });
    expect(classify(profile(null, [{ extensionId: EXT, isDisabled: false }]))).toEqual({ state: 'sem_relatorio', reportAt: null });
  });
});

describe('classifyExtension (A15-2: relatório velho ou contraditório NÃO vira "ausente")', () => {
  it(`relatório com mais de ${REPORT_MAX_AGE_HOURS} h é sem_relatorio — mesmo que a extensão apareça ausente; no limite (48 h exatas) ainda vale`, () => {
    expect(REPORT_MAX_AGE_HOURS).toBe(48);
    const velho = profile(48.01, []);
    expect(classify(velho)).toEqual({ state: 'sem_relatorio', reportAt: velho.lastStatusReportTime });
    expect(classify(profile(48.01, [{ extensionId: EXT, isDisabled: true }])).state).toBe('sem_relatorio');
    expect(classify(profile(48, [])).state).toBe('ausente'); // controle: no limite o relatório ainda é fresco
  });

  it('perfil sem a extensão MAS a pessoa está na lista de instalações: os dois relatórios se contradizem → sem_relatorio, nunca ausente', () => {
    expect(classify(profile(2, []), true).state).toBe('sem_relatorio');
    expect(classify(profile(2, []), false).state).toBe('ausente'); // controle
  });

  it('só os 3 estados com informação são conclusivos (geram evento e aviso)', () => {
    expect(['sem_relatorio', 'ausente', 'desativada', 'instalada'].map((s) => isConclusive(s as never))).toEqual([false, true, true, true]);
  });
});
