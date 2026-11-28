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
      id: 'v1', patient_first_name: 'Juan', patient_last_name: 'Perez', case_number: 42, case_ordinal: 1, vacancy_number: 1, status: 'ACTIVE',
      is_draft: false, dias_aberto: 3, convidados: 1, postulados: 1, selecionados: 0, faltantes: null,
    };
    expect(mapVacancyListRow(base)).toMatchObject({ initials: 'JP', name: 'Juan Perez' });
    const redigida = mapVacancyListRow(projectPatientInVacancy(base, ['vacancy:read']));
    expect(redigida).toMatchObject({ initials: INICIAIS_REDIGIDAS, name: NOME_REDIGIDO, caseNumber: 42, caseOrdinal: 1 });
    expect(redigida).not.toHaveProperty('caso');
    expect(patientNameIsRedacted({ patient_first_name: NOME_REDIGIDO, patient_last_name: 'x' })).toBe(false);
  });
});

describe('projectPatientInVacancy — patient_status sob o container `patient` (estado-automatico-do-paciente F2, E6)', () => {
  const COM_ESTADO = { ...ROW, patient_id: 'p1', patient_status: 'SEARCHING' };
  const marcador = (r: object): unknown => (r as { redacted?: unknown }).redacted;

  it('com patient:read o estado do paciente sai como veio; sem a célula vira null + redacted.patient (marcador constante)', () => {
    expect(projectPatientInVacancy(COM_ESTADO, ['vacancy:read', 'patient:read', 'patient_identity:read', 'patient_address:read', 'patient_clinical:read'])).toBe(COM_ESTADO);
    const sem = projectPatientInVacancy(COM_ESTADO, ['vacancy:read', 'patient_identity:read', 'patient_address:read', 'patient_clinical:read']);
    expect(sem.patient_status).toBeNull();
    expect(marcador(sem)).toEqual({ patient: true });
    expect(COM_ESTADO.patient_status).toBe('SEARCHING'); // não muta a linha
  });

  it('o marcador sai mesmo quando o campo está vazio ("existe estado" não vaza por ausência)', () => {
    const sem = projectPatientInVacancy({ ...COM_ESTADO, patient_status: null }, ['vacancy:read']);
    expect(sem).toMatchObject({ patient_status: null, redacted: { patient: true } });
  });

  it('cells = null (engine não decidiu) → como antes: lê (D113)', () => {
    expect(projectPatientInVacancy(COM_ESTADO, null)).toBe(COM_ESTADO);
  });

  it('vaga SEM paciente → sem a chave (nunca null: null só significa "sem célula"), com ou sem a célula', () => {
    const semPaciente = { ...ROW, patient_id: null, patient_status: null };
    for (const cells of [['vacancy:read', 'patient:read'], ['vacancy:read'], null]) {
      const out = projectPatientInVacancy(semPaciente, cells);
      expect('patient_status' in out).toBe(false);
      expect(marcador(out)).toBeUndefined();
    }
  });

  it('paciente legado sem estado + com a célula → sem a chave', () => {
    const out = projectPatientInVacancy({ ...ROW, patient_id: 'p1', patient_status: null }, ['patient:read', 'patient_identity:read', 'patient_address:read', 'patient_clinical:read']);
    expect('patient_status' in out).toBe(false);
  });

  it('o estado e a redação do nome/endereço são independentes (uma célula não abre a outra)', () => {
    const out = projectPatientInVacancy(COM_ESTADO, ['patient:read']);
    expect(out).toMatchObject({ patient_status: 'SEARCHING', patient_first_name: NOME_REDIGIDO, patient_zone: null });
    expect(marcador(out)).toBeUndefined();
  });
});
