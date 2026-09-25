import { describe, it, expect } from 'vitest';
import { KNOWN_LOCKED_FIELDS } from '../VacancyDetail/draftVacancyFields';
import {
  LOCKED_COLUMN_TO_FORM_FIELD,
  LOCKED_COLUMNS_WITHOUT_FORM_FIELD,
  lockedFormFields,
  stripLockedFields,
} from '../vacancyLockedFields';

describe('LOCKED_COLUMN_TO_FORM_FIELD — inversão do mapa coluna → campo do form', () => {
  it('todo campo travado de KNOWN_LOCKED_FIELDS (espelho dos 8 nomes do backend) resolve no mapa — como campo do form ou declarado null', () => {
    for (const column of KNOWN_LOCKED_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(LOCKED_COLUMN_TO_FORM_FIELD, column)).toBe(true);
    }
    // paridade nos dois sentidos: o mapa não inventa coluna que o backend não tem
    expect(Object.keys(LOCKED_COLUMN_TO_FORM_FIELD).sort()).toEqual([...KNOWN_LOCKED_FIELDS].sort());
  });

  it('as colunas sem campo de form são exatamente case_number, patient_id, contracted_service_id', () => {
    expect(new Set(LOCKED_COLUMNS_WITHOUT_FORM_FIELD)).toEqual(
      new Set(['case_number', 'patient_id', 'contracted_service_id']),
    );
  });

  it('as demais 5 colunas resolvem para o campo de form que buildVacancyPayload usa para montar o PUT', () => {
    expect(LOCKED_COLUMN_TO_FORM_FIELD.patient_address_id).toBe('patientAddressId');
    expect(LOCKED_COLUMN_TO_FORM_FIELD.age_range_min).toBe('age_range_min');
    expect(LOCKED_COLUMN_TO_FORM_FIELD.age_range_max).toBe('age_range_max');
    expect(LOCKED_COLUMN_TO_FORM_FIELD.schedule).toBe('schedule');
    expect(LOCKED_COLUMN_TO_FORM_FIELD.providers_needed).toBe('providers_needed');
  });
});

describe('lockedFormFields', () => {
  it('deriva o conjunto de campos do form a partir de locked_fields do GET', () => {
    const result = lockedFormFields(['schedule', 'patient_address_id', 'contracted_service_id']);
    expect(result).toEqual(new Set(['schedule', 'patientAddressId']));
  });

  it('devolve conjunto vazio quando locked_fields é undefined, null ou []', () => {
    expect(lockedFormFields(undefined)).toEqual(new Set());
    expect(lockedFormFields(null)).toEqual(new Set());
    expect(lockedFormFields([])).toEqual(new Set());
  });
});

describe('stripLockedFields', () => {
  it('remove do body toda chave presente em lockedFields', () => {
    const body = { schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }], salary_text: 'A convenir' };
    const result = stripLockedFields(body, ['schedule']);
    expect(result).toEqual({ salary_text: 'A convenir' });
    expect(result).not.toHaveProperty('schedule');
  });

  it('não muta o body original', () => {
    const body = { schedule: [], salary_text: 'A convenir' };
    stripLockedFields(body, ['schedule']);
    expect(body).toHaveProperty('schedule');
  });

  it('devolve o body como veio quando lockedFields é undefined, null ou []', () => {
    const body = { schedule: [], salary_text: 'A convenir' };
    expect(stripLockedFields(body, undefined)).toEqual(body);
    expect(stripLockedFields(body, null)).toEqual(body);
    expect(stripLockedFields(body, [])).toEqual(body);
  });

  it('vaga sem locked_fields (Nueva antiga): body igual ao de hoje — nada removido', () => {
    const body = {
      case_number: 123,
      patient_id: 'p1',
      patient_address_id: 'a1',
      schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }],
      providers_needed: 1,
    };
    expect(stripLockedFields(body, [])).toEqual(body);
  });
});
