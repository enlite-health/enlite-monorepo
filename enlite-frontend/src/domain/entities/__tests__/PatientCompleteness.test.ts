/**
 * Spec 014 (lex D1.2): a lista de códigos do checklist é fechada, sem item clínico — espelha
 * `PATIENT_COMPLETENESS_CODES` do backend (`worker-functions/src/modules/case/domain/
 * PatientCompleteness.ts`). Um VALUE import (não `import type`) é necessário para o módulo
 * (const array) ser instrumentado pela cobertura — só re-export/import type nunca executa o
 * corpo do arquivo.
 */
import { describe, it, expect } from 'vitest';
import {
  PATIENT_COMPLETENESS_CODES,
  ACTIVATION_BLOCKING_CODES,
  ACTIVATABLE_STATUSES,
  RECRUITMENT_BLOCKING_CODES,
  isPlaceholderCoverageValue,
  recruitmentMissingCodes,
  type PatientCompletenessCode,
} from '../PatientCompleteness';

describe('PATIENT_COMPLETENESS_CODES (front espelha o backend)', () => {
  it('é exatamente os 7 códigos administrativos, nesta ordem (SERVICE_SCHEDULE desde 07/09)', () => {
    expect(PATIENT_COMPLETENESS_CODES).toEqual([
      'ADDRESS',
      'RESPONSIBLE',
      'COVERAGE',
      'CONTRACTED_SERVICE',
      'SERVICE_ADDRESS',
      'SERVICE_SCHEDULE',
      'CONSENT',
    ]);
  });

  it('nenhum código nomeia conteúdo clínico', () => {
    const clinicalWords = /diagn|patol|clinic|instruc|emerg/i;
    for (const code of PATIENT_COMPLETENESS_CODES as readonly string[]) {
      expect(clinicalWords.test(code)).toBe(false);
    }
  });

  it('o tipo PatientCompletenessCode aceita cada valor da lista (checagem em tempo de execução via array)', () => {
    const sample: PatientCompletenessCode = PATIENT_COMPLETENESS_CODES[0];
    expect(PATIENT_COMPLETENESS_CODES).toContain(sample);
  });
});

describe('ACTIVATION_BLOCKING_CODES (D255 + migration 330, espelha o backend)', () => {
  it('é ADDRESS, SERVICE_ADDRESS e SERVICE_SCHEDULE (decisão do Gabriel 07/09)', () => {
    expect(ACTIVATION_BLOCKING_CODES).toEqual(['ADDRESS', 'SERVICE_ADDRESS', 'SERVICE_SCHEDULE']);
  });

  it('todo código bloqueante pertence ao catálogo — sem código órfão no espelho', () => {
    for (const code of ACTIVATION_BLOCKING_CODES) {
      expect(PATIENT_COMPLETENESS_CODES as readonly string[]).toContain(code);
    }
  });
});

describe('ACTIVATABLE_STATUSES (espelha o backend — unifica ActivatePatientButton/PatientDetailPage)', () => {
  it('é ADMISSION e PENDING_ADMISSION', () => {
    expect(ACTIVATABLE_STATUSES).toEqual(['ADMISSION', 'PENDING_ADMISSION']);
  });
});

/**
 * `isPlaceholderCoverageValue` (018-pr6, FR-121/122) — mesma régua do backend: "sin cobertura /
 * particular" É resposta válida; placeholder (vazio, < 2 alfanuméricos, ou só zeros) não é.
 * Cobre os DOIS ramos de CADA `if` (vazio/não-vazio, < 2/>= 2 alfanuméricos, todo-zero/não).
 */
describe('isPlaceholderCoverageValue (FR-121/122, espelha o backend)', () => {
  it('null/undefined/string vazia (ou só espaço) → placeholder', () => {
    expect(isPlaceholderCoverageValue(null)).toBe(true);
    expect(isPlaceholderCoverageValue(undefined)).toBe(true);
    expect(isPlaceholderCoverageValue('')).toBe(true);
    expect(isPlaceholderCoverageValue('   ')).toBe(true);
  });

  it('menos de 2 caracteres alfanuméricos (mesmo com pontuação em volta) → placeholder', () => {
    expect(isPlaceholderCoverageValue('A')).toBe(true);
    expect(isPlaceholderCoverageValue('!!')).toBe(true); // 0 alfanuméricos
    expect(isPlaceholderCoverageValue('-')).toBe(true);
  });

  it('só zeros (2+ dígitos) → placeholder', () => {
    expect(isPlaceholderCoverageValue('00')).toBe(true);
    expect(isPlaceholderCoverageValue('000')).toBe(true);
    expect(isPlaceholderCoverageValue('0-0')).toBe(true); // pontuação some, sobra "00"
  });

  it('"Particular"/"Sin cobertura"/nome de obra social real → resposta válida, NÃO placeholder', () => {
    expect(isPlaceholderCoverageValue('Particular')).toBe(false);
    expect(isPlaceholderCoverageValue('Sin cobertura')).toBe(false);
    expect(isPlaceholderCoverageValue('OSDE')).toBe(false);
    expect(isPlaceholderCoverageValue('0A')).toBe(false); // 2+ alfanuméricos, mas NÃO só zeros
  });
});

describe('recruitmentMissingCodes (gate de "Activar reclutamiento", espelha RECRUITMENT_BLOCKING_CODES)', () => {
  it('tudo presente → vazio (pronto para ativar)', () => {
    expect(recruitmentMissingCodes({ serviceHasAddress: true, serviceHasSchedule: true, insuranceInformed: 'Particular' })).toEqual([]);
  });

  it('falta endereço do serviço → SERVICE_ADDRESS', () => {
    expect(recruitmentMissingCodes({ serviceHasAddress: false, serviceHasSchedule: true, insuranceInformed: 'Particular' }))
      .toEqual(['SERVICE_ADDRESS']);
  });

  it('falta horário do serviço → SERVICE_SCHEDULE', () => {
    expect(recruitmentMissingCodes({ serviceHasAddress: true, serviceHasSchedule: false, insuranceInformed: 'Particular' }))
      .toEqual(['SERVICE_SCHEDULE']);
  });

  it('cobertura placeholder (null) → COVERAGE', () => {
    expect(recruitmentMissingCodes({ serviceHasAddress: true, serviceHasSchedule: true, insuranceInformed: null }))
      .toEqual(['COVERAGE']);
  });

  it('faltando tudo → os 3 códigos, nesta ordem (a mesma de RECRUITMENT_BLOCKING_CODES)', () => {
    expect(recruitmentMissingCodes({ serviceHasAddress: false, serviceHasSchedule: false, insuranceInformed: null }))
      .toEqual([...RECRUITMENT_BLOCKING_CODES]);
  });
});
