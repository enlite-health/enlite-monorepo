/**
 * patientsData.test.ts
 *
 * Cobre TODAS as funções do arquivo (perfil.md D200.12: cobertura 100% do
 * arquivo tocado). `getScopedCountryOptions` é a única nova (PR-9, `lex` #9,
 * FR-734); o resto é pré-existente sem teste dedicado até agora.
 */
import { describe, it, expect } from 'vitest';
import {
  getAttentionOptions,
  getReasonOptions,
  getSpecialtyOptions,
  getCountryOptions,
  getScopedCountryOptions,
  getFunnelPeriodOptions,
  getDependencyOptions,
  attentionToApiParam,
} from '../patientsData';

const t = ((key: string) => key) as unknown as import('i18next').TFunction;

describe('patientsData', () => {
  it('getAttentionOptions: complete + needs_attention', () => {
    expect(getAttentionOptions(t)).toEqual([
      { value: 'complete', label: 'admin.patients.attentionOptions.complete' },
      { value: 'needs_attention', label: 'admin.patients.attentionOptions.needsAttention' },
    ]);
  });

  it('getReasonOptions: MISSING_INFO', () => {
    expect(getReasonOptions(t)).toEqual([
      { value: 'MISSING_INFO', label: 'admin.patients.reasonOptions.MISSING_INFO' },
    ]);
  });

  it('getSpecialtyOptions: as 8 especialidades, na ordem', () => {
    const opts = getSpecialtyOptions(t);
    expect(opts.map((o) => o.value)).toEqual([
      'INTELLECTUAL_DISABILITY', 'NEUROLOGICAL', 'MOTOR_LIMITATIONS', 'ASD',
      'PSYCHIATRIC', 'SOCIAL_VULNERABILITY', 'GERIATRIC', 'SPECIFIC_PATHOLOGY', 'CUSTOM',
    ]);
  });

  it('getCountryOptions: lista FIXA AR+BR (uso pré-existente, fora do escopo do ator)', () => {
    expect(getCountryOptions(t)).toEqual([
      { value: 'AR', label: 'admin.patients.countryOptions.AR' },
      { value: 'BR', label: 'admin.patients.countryOptions.BR' },
    ]);
  });

  describe('getScopedCountryOptions (PR-9, FR-734)', () => {
    it('mapeia CADA país do escopo do ator, na mesma ordem — nunca a lista fixa do sistema', () => {
      expect(getScopedCountryOptions(t, ['AR'])).toEqual([
        { value: 'AR', label: 'admin.patients.countryOptions.AR' },
      ]);
      expect(getScopedCountryOptions(t, ['BR', 'AR'])).toEqual([
        { value: 'BR', label: 'admin.patients.countryOptions.BR' },
        { value: 'AR', label: 'admin.patients.countryOptions.AR' },
      ]);
    });

    it('escopo vazio → lista vazia (nunca cai para a lista fixa do sistema)', () => {
      expect(getScopedCountryOptions(t, [])).toEqual([]);
    });
  });

  it('getFunnelPeriodOptions: 7/30/90', () => {
    expect(getFunnelPeriodOptions(t).map((o) => o.value)).toEqual(['7', '30', '90']);
  });

  it('getDependencyOptions: as 4 faixas', () => {
    expect(getDependencyOptions(t).map((o) => o.value)).toEqual([
      'SEVERE', 'VERY_SEVERE', 'MODERATE', 'MILD',
    ]);
  });

  describe('attentionToApiParam', () => {
    it('complete → "false"', () => expect(attentionToApiParam('complete')).toBe('false'));
    it('needs_attention → "true"', () => expect(attentionToApiParam('needs_attention')).toBe('true'));
    it('qualquer outro valor (inclusive vazio) → undefined (omite o param)', () => {
      expect(attentionToApiParam('')).toBeUndefined();
      expect(attentionToApiParam('lixo')).toBeUndefined();
    });
  });
});
