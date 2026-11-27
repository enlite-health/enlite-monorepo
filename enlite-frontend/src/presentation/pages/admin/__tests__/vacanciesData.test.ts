/**
 * vacanciesData.test.ts
 *
 * GARANTIA: os filtros da lista de vagas (estado-automatico-do-paciente, F2, E7):
 *  - NÃO há filtro de "Ciclo de vida" (F4)
 *  - "Estado del paciente": os estados do paciente, com os rótulos das colunas do Kanban de pacientes
 *  - Usam i18n keys, nunca strings hardcoded
 */

import { describe, it, expect } from 'vitest';
import * as vacanciesData from '../vacanciesData';
import { getPatientStatusOptions } from '../vacanciesData';
import { PATIENT_STATUSES } from '@domain/entities/patientEnums';

// Mock i18n t function — retorna a chave como string
const t = ((key: string) => key) as any;

describe('vacanciesData — sem filtro de Ciclo de vida (semaforo-da-vaga F4)', () => {
  it('o módulo não exporta getLifecycleOptions: "Mostrar dadas de baja" cobre a baixa e ninguém filtra por estado da vaga', () => {
    expect(Object.keys(vacanciesData)).not.toContain('getLifecycleOptions');
  });
});

describe('vacanciesData — Estado del paciente', () => {
  it('oferece todos os estados do paciente, com a chave das colunas do Kanban de pacientes', () => {
    const options = getPatientStatusOptions(t);
    expect(options.map((o) => o.value)).toEqual([...PATIENT_STATUSES]);
    for (const o of options) expect(o.label).toBe(`admin.patients.kanban.columns.${o.value}`);
  });
});
