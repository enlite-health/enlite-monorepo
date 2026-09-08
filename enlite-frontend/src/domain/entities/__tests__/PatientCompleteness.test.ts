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
