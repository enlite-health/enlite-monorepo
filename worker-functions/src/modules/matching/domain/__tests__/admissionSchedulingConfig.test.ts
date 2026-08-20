/**
 * admissionSchedulingConfig.test.ts
 *
 * O que estes testes protegem é o go-live: com a flag ausente, tudo — fonte,
 * duração e antecedência — tem que ficar igual ao que está em produção hoje,
 * porque o merge no `main` deploya sozinho. Com a flag ligada, valem os números
 * do spec (60min / 4h).
 */

import {
  isHostRosterEnabled,
  resolveMinLeadMinutes,
  resolveSlotMinutes,
} from '../admissionSchedulingConfig';

const TOUCHED = [
  'ADMISSION_HOST_ROSTER_ENABLED',
  'ADMISSION_SLOT_MINUTES',
  'ADMISSION_MIN_LEAD_MINUTES',
] as const;

describe('admissionSchedulingConfig', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of TOUCHED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  });

  describe('isHostRosterEnabled', () => {
    it('ausente → false (produção neutra no merge)', () => {
      expect(isHostRosterEnabled()).toBe(false);
    });

    it('só a string exata "true" liga', () => {
      for (const v of ['false', 'TRUE', '1', 'yes', '', ' true']) {
        process.env.ADMISSION_HOST_ROSTER_ENABLED = v;
        expect(isHostRosterEnabled()).toBe(false);
      }
      process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';
      expect(isHostRosterEnabled()).toBe(true);
    });
  });

  describe('resolveSlotMinutes', () => {
    it('flag off → 45min, o que está no ar hoje', () => {
      expect(resolveSlotMinutes()).toBe(45);
    });

    it('flag on → 60min, o que o spec exige', () => {
      process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';
      expect(resolveSlotMinutes()).toBe(60);
    });

    it('env sobrescreve nos dois modos', () => {
      process.env.ADMISSION_SLOT_MINUTES = '30';
      expect(resolveSlotMinutes()).toBe(30);
      process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';
      expect(resolveSlotMinutes()).toBe(30);
    });
  });

  describe('resolveMinLeadMinutes', () => {
    it('flag off → 120min (2h), o que está no ar hoje', () => {
      expect(resolveMinLeadMinutes()).toBe(120);
    });

    it('flag on → 240min (4h), o que a Ana pediu', () => {
      process.env.ADMISSION_HOST_ROSTER_ENABLED = 'true';
      expect(resolveMinLeadMinutes()).toBe(240);
    });

    it('env sobrescreve', () => {
      process.env.ADMISSION_MIN_LEAD_MINUTES = '360';
      expect(resolveMinLeadMinutes()).toBe(360);
    });
  });

  describe('env inválida NÃO vira grade quebrada em silêncio', () => {
    it.each([
      ['vazio', ''],
      ['só espaço', '   '],
      ['texto', 'abc'],
      ['zero', '0'],
      ['negativo', '-5'],
      ['fracionário', '45.5'],
    ])('%s → cai no default do modo', (_label, value) => {
      process.env.ADMISSION_SLOT_MINUTES = value;
      process.env.ADMISSION_MIN_LEAD_MINUTES = value;
      expect(resolveSlotMinutes()).toBe(45);
      expect(resolveMinLeadMinutes()).toBe(120);
    });

    it('valor com espaço em volta ainda é aceito', () => {
      process.env.ADMISSION_MIN_LEAD_MINUTES = ' 240 ';
      expect(resolveMinLeadMinutes()).toBe(240);
    });
  });
});
