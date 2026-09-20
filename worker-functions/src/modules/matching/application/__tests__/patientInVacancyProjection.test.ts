import { NOME_REDIGIDO } from '@modules/identity/permissions';
import { INICIAIS_REDIGIDAS, canSearchVacanciesByPatientName, patientNameIsRedacted, projectPatientInVacancy } from '../patientInVacancyProjection';
import { mapVacancyListRow, type VacancyListRow } from '../../interfaces/controllers/vacancyListHelpers';

const ROW = {
  id: 'v1', patient_first_name: 'Juan', patient_last_name: 'Perez', patient_zone: 'Palermo', patient_city: 'CABA',
  patient_address_formatted: 'Calle Falsa 123, CABA', patient_address_raw: 'calle falsa 123', dependency_level: 'ALTA',
};

describe('projectPatientInVacancy — o dado do paciente dentro da vaga segue a célula do PACIENTE (D286 fase 2)', () => {
  it('cells = null (engine não decidiu) → o MESMO objeto, sem cópia (D113)', () => {
    expect(projectPatientInVacancy(ROW, null)).toBe(ROW);
    expect(projectPatientInVacancy(ROW, undefined)).toBe(ROW);
  });

  it('com identidade, endereço e clínica → o mesmo objeto; vacancy:read sozinho não abre nenhum dos três', () => {
    expect(projectPatientInVacancy(ROW, ['vacancy:read', 'patient_identity:read', 'patient_address:read', 'patient_clinical:read'])).toBe(ROW);
    const so = projectPatientInVacancy(ROW, ['vacancy:read']);
    expect(so).toEqual({
      id: 'v1', patient_first_name: NOME_REDIGIDO, patient_last_name: null,
      // zona/cidade seguem a célula de ENDEREÇO (lex cond. 7); dependência é SAÚDE (P3)
      patient_zone: null, patient_city: null, patient_address_formatted: null, patient_address_raw: null, dependency_level: null,
    });
    expect(ROW.patient_first_name).toBe('Juan'); // não muta a linha
  });

  it('cada célula abre só o seu dado', () => {
    expect(projectPatientInVacancy(ROW, ['patient_identity:read'])).toMatchObject({ patient_first_name: 'Juan', patient_last_name: 'Perez', patient_address_formatted: null, patient_zone: null, dependency_level: null });
    expect(projectPatientInVacancy(ROW, ['patient_address:read'])).toMatchObject({ patient_first_name: NOME_REDIGIDO, patient_address_formatted: 'Calle Falsa 123, CABA', patient_zone: 'Palermo', patient_city: 'CABA', dependency_level: null });
    expect(projectPatientInVacancy(ROW, ['patient_clinical:read'])).toMatchObject({ patient_first_name: NOME_REDIGIDO, patient_zone: null, dependency_level: 'ALTA' });
  });

  it('busca por nome na lista só para quem lê o nome (P5); null → como antes', () => {
    expect(canSearchVacanciesByPatientName(null)).toBe(true);
    expect(canSearchVacanciesByPatientName(['vacancy:read'])).toBe(false);
    expect(canSearchVacanciesByPatientName(['vacancy:read', 'patient_identity:read'])).toBe(true);
  });

  it('linha sem os campos (outra query) não ganha campos novos', () => {
    const magra = { id: 'v2', patient_first_name: 'Ana', patient_last_name: 'Lima' };
    const out = projectPatientInVacancy(magra, []);
    expect(out).toEqual({ id: 'v2', patient_first_name: NOME_REDIGIDO, patient_last_name: null });
    expect('patient_address_formatted' in out).toBe(false);
  });

  it('a lista: nome redigido vira iniciais "—", nunca as do rótulo', () => {
    const base: VacancyListRow = {
      id: 'v1', patient_first_name: 'Juan', patient_last_name: 'Perez', case_number: 42, vacancy_number: 1, status: 'ACTIVE',
      is_draft: false, priority: null, dias_aberto: 3, convidados: 1, postulados: 1, confirmados: 0, selecionados: 0, faltantes: null,
    };
    expect(mapVacancyListRow(base)).toMatchObject({ initials: 'JP', name: 'Juan Perez' });
    const redigida = mapVacancyListRow(projectPatientInVacancy(base, ['vacancy:read']));
    expect(redigida).toMatchObject({ initials: INICIAIS_REDIGIDAS, name: NOME_REDIGIDO, caso: 'Caso 42-1' });
    expect(patientNameIsRedacted({ patient_first_name: NOME_REDIGIDO, patient_last_name: 'x' })).toBe(false);
  });
});
