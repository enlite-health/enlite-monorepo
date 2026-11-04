import { vacancyLinkEligibility, type VacancyForLink } from '../VacancyLinkEligibility';

const SERVICE = { patientId: 'p1' };
const base: VacancyForLink = {
  patientId: 'p1',
  contractedServiceId: null,
  deletedAt: null,
  status: 'SEARCHING',
};

describe('vacancyLinkEligibility', () => {
  it('vaga apagada -> DELETED', () => {
    expect(vacancyLinkEligibility({ ...base, deletedAt: new Date() }, SERVICE)).toEqual({
      eligible: false,
      reason: 'DELETED',
    });
  });

  it('vaga de outro paciente -> OTHER_PATIENT', () => {
    expect(vacancyLinkEligibility({ ...base, patientId: 'p2' }, SERVICE)).toEqual({
      eligible: false,
      reason: 'OTHER_PATIENT',
    });
  });

  it('vaga sem paciente -> OTHER_PATIENT', () => {
    expect(vacancyLinkEligibility({ ...base, patientId: null }, SERVICE)).toEqual({
      eligible: false,
      reason: 'OTHER_PATIENT',
    });
  });

  it('vaga já vinculada -> ALREADY_LINKED', () => {
    expect(vacancyLinkEligibility({ ...base, contractedServiceId: 's9' }, SERVICE)).toEqual({
      eligible: false,
      reason: 'ALREADY_LINKED',
    });
  });

  it('vaga em DE_BAJA -> DE_BAJA', () => {
    expect(vacancyLinkEligibility({ ...base, status: 'DE_BAJA' }, SERVICE)).toEqual({
      eligible: false,
      reason: 'DE_BAJA',
    });
  });

  it('status CLOSED é elegível', () => {
    expect(vacancyLinkEligibility({ ...base, status: 'CLOSED' }, SERVICE)).toEqual({ eligible: true });
  });

  it('status null é elegível', () => {
    expect(vacancyLinkEligibility({ ...base, status: null }, SERVICE)).toEqual({ eligible: true });
  });

  it('precedência: apagada E de outro paciente -> DELETED', () => {
    expect(
      vacancyLinkEligibility({ ...base, deletedAt: '2026-01-01', patientId: 'p2' }, SERVICE),
    ).toEqual({ eligible: false, reason: 'DELETED' });
  });
});
