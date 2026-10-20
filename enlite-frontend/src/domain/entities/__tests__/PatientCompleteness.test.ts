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
  const FIELDS = { requiredProfessions: ['AT'], requiredSex: 'F', requiredExperience: 'exp', workSchedule: 'part-time', paymentDay: 'dia 5' };
  const BASE = { serviceHasAddress: true, serviceHasSchedule: true, insuranceInformed: 'Particular' };
  // helper: sem `serviceRecruitmentFields` explícito, os 5 campos vêm preenchidos (os casos antigos medem OUTROS códigos).
  const rm = (i: Parameters<typeof recruitmentMissingCodes>[0]) => recruitmentMissingCodes({ serviceRecruitmentFields: FIELDS, ...i });

  // Spec 027 Fase 3 (D508 c, lex S.2) — espelha o backend.
  it('requiredSex null → SERVICE_REQUIRED_SEX; BOTH → ok', () => {
    expect(recruitmentMissingCodes({ ...BASE, serviceRecruitmentFields: { ...FIELDS, requiredSex: null } })).toEqual(['SERVICE_REQUIRED_SEX']);
    expect(recruitmentMissingCodes({ ...BASE, serviceRecruitmentFields: { ...FIELDS, requiredSex: 'BOTH' } })).toEqual([]);
  });
  it('cada um dos 5 faltando (lista vazia, texto em branco, null) devolve SÓ o código do próprio campo; sem o objeto = os 5 em ordem', () => {
    const cases: Array<[Partial<typeof FIELDS>, string]> = [
      [{ requiredProfessions: [] }, 'SERVICE_REQUIRED_PROFESSIONS'],
      [{ requiredProfessions: ['  '] }, 'SERVICE_REQUIRED_PROFESSIONS'],
      [{ requiredSex: null as never }, 'SERVICE_REQUIRED_SEX'],
      [{ requiredExperience: '  ' }, 'SERVICE_REQUIRED_EXPERIENCE'],
      [{ workSchedule: null as never }, 'SERVICE_WORK_SCHEDULE'],
      [{ paymentDay: '' }, 'SERVICE_PAYMENT_DAY'],
    ];
    for (const [f, code] of cases) {
      expect(recruitmentMissingCodes({ ...BASE, serviceRecruitmentFields: { ...FIELDS, ...f } })).toEqual([code]);
    }
    expect(recruitmentMissingCodes(BASE)).toEqual(['SERVICE_REQUIRED_PROFESSIONS', 'SERVICE_REQUIRED_SEX', 'SERVICE_REQUIRED_EXPERIENCE', 'SERVICE_WORK_SCHEDULE', 'SERVICE_PAYMENT_DAY']);
  });
  it('só paymentDay vazio (caso real): missing é exatamente o dia de pago, sem os outros 4', () => {
    const r = recruitmentMissingCodes({ ...BASE, serviceRecruitmentFields: { ...FIELDS, paymentDay: null } });
    expect(r).toEqual(['SERVICE_PAYMENT_DAY']);
    expect(r).not.toContain('SERVICE_REQUIRED_SEX');
  });

  it('tudo presente → vazio (pronto para ativar)', () => {
    expect(rm({ serviceHasAddress: true, serviceHasSchedule: true, insuranceInformed: 'Particular' })).toEqual([]);
  });

  it('falta endereço do serviço → SERVICE_ADDRESS', () => {
    expect(rm({ serviceHasAddress: false, serviceHasSchedule: true, insuranceInformed: 'Particular' }))
      .toEqual(['SERVICE_ADDRESS']);
  });

  it('falta horário do serviço → SERVICE_SCHEDULE', () => {
    expect(rm({ serviceHasAddress: true, serviceHasSchedule: false, insuranceInformed: 'Particular' }))
      .toEqual(['SERVICE_SCHEDULE']);
  });

  it('cobertura placeholder (null) → COVERAGE', () => {
    expect(rm({ serviceHasAddress: true, serviceHasSchedule: true, insuranceInformed: null }))
      .toEqual(['COVERAGE']);
  });

  it('faltando tudo → os 4 códigos, nesta ordem (a mesma de RECRUITMENT_BLOCKING_CODES)', () => {
    expect(recruitmentMissingCodes({ serviceHasAddress: false, serviceHasSchedule: false, insuranceInformed: null }))
      .toEqual([...RECRUITMENT_BLOCKING_CODES]);
  });

  // Hotfix gate-cobertura-verificada-vacante (28/09): paciente com cobertura VERIFICADA válida
  // (patient_insurance_verified, provider ativo) mas sem o legado — o foguete ficava desabilitado
  // com tooltip "Falta: COVERAGE" mesmo tendo cobertura válida pelo caminho novo.
  it('só legado preenchido → COVERAGE não falta (regressão do comportamento atual)', () => {
    expect(
      rm({ serviceHasAddress: true, serviceHasSchedule: true, insuranceInformed: 'Particular', hasVerifiedActiveCoverage: false }),
    ).toEqual([]);
  });

  it('só cobertura verificada válida (sem legado) → COVERAGE não falta — é o caso do bug', () => {
    expect(
      rm({ serviceHasAddress: true, serviceHasSchedule: true, insuranceInformed: null, hasVerifiedActiveCoverage: true }),
    ).toEqual([]);
  });

  it('nenhuma das duas → COVERAGE continua faltando', () => {
    expect(
      rm({ serviceHasAddress: true, serviceHasSchedule: true, insuranceInformed: null, hasVerifiedActiveCoverage: false }),
    ).toEqual(['COVERAGE']);
  });

  it('SERVICE_ADDRESS/SERVICE_SCHEDULE continuam bloqueando mesmo com COVERAGE ok pela cobertura verificada', () => {
    expect(
      rm({ serviceHasAddress: false, serviceHasSchedule: false, insuranceInformed: null, hasVerifiedActiveCoverage: true }),
    ).toEqual(['SERVICE_ADDRESS', 'SERVICE_SCHEDULE']);
  });
});
