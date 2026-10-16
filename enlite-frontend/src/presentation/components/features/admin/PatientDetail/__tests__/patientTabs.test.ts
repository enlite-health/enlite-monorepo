import { describe, it, expect } from 'vitest';
import { PATIENT_TABS, parsePatientTab, patientTabPath } from '../patientTabs';

describe('parsePatientTab — ?tab= validado contra a união', () => {
  it.each(PATIENT_TABS)('aceita o valor exato da aba %s', (tab) => {
    expect(parsePatientTab(tab)).toBe(tab);
  });

  it.each([['lixo'], [''], ['CONTRACTEDSERVICE'], ['Servicio Contratado'], [null], [undefined]])(
    'valor inválido ou ausente (%s) → null',
    (raw) => {
      expect(parsePatientTab(raw as string | null | undefined)).toBeNull();
    },
  );
});

describe('patientTabPath', () => {
  it('monta /admin/patients/:id?tab=<aba> com o literal da união', () => {
    expect(patientTabPath('p-1', 'contractedService')).toBe('/admin/patients/p-1?tab=contractedService');
    expect(parsePatientTab('contractedService')).toBe('contractedService');
  });
});
