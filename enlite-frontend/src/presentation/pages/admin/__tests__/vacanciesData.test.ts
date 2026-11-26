/**
 * vacanciesData.test.ts
 *
 * GARANTIA: os filtros da lista de vagas (estado-automatico-do-paciente, F2, E7):
 *  - "Ciclo de vida": os 5 valores do dono (nenhum valor de banco legado, nenhum `value=""`)
 *  - "Estado del paciente": os estados do paciente, com os rótulos das colunas do Kanban de pacientes
 *  - Usam i18n keys, nunca strings hardcoded
 */

import { describe, it, expect } from 'vitest';
import { getLifecycleOptions, getPatientStatusOptions } from '../vacanciesData';
import { CICLOS_DE_VIDA } from '@domain/value-objects/vacancyLifecycle';
import { PATIENT_STATUSES } from '@domain/entities/patientEnums';

// Mock i18n t function — retorna a chave como string
const t = ((key: string) => key) as any;

describe('vacanciesData — Ciclo de vida', () => {
  it('são exatamente os 5 ciclos do dono, na ordem, e nenhum value=""', () => {
    const options = getLifecycleOptions(t);
    expect(options.map((o) => o.value)).toEqual([...CICLOS_DE_VIDA]);
    expect(options.filter((o) => o.value === '')).toHaveLength(0);
  });

  it('nenhum valor de banco da vaga (SEARCHING_REPLACEMENT, RAPID_RESPONSE, ACTIVE…) é oferecido', () => {
    const values = getLifecycleOptions(t).map((o) => String(o.value));
    for (const legado of ['SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'PENDING_ACTIVATION', 'ACTIVE', 'ON_HOLD', 'DE_BAJA']) {
      expect(values).not.toContain(legado);
    }
  });

  it('os rótulos são chaves i18n do ciclo de vida', () => {
    for (const o of getLifecycleOptions(t)) expect(o.label).toMatch(/^admin\.vacancyDetail\.lifecycle\./);
  });
});

describe('vacanciesData — Estado del paciente', () => {
  it('oferece todos os estados do paciente, com a chave das colunas do Kanban de pacientes', () => {
    const options = getPatientStatusOptions(t);
    expect(options.map((o) => o.value)).toEqual([...PATIENT_STATUSES]);
    for (const o of options) expect(o.label).toBe(`admin.patients.kanban.columns.${o.value}`);
  });
});
