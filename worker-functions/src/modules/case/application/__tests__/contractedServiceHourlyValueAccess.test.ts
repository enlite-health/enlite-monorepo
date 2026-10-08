/**
 * contractedServiceHourlyValueAccess — o preço do contrato sai pela célula
 * `patient_contract_value:read`; sem decisão do engine (`cells === null`), pelo
 * papel `admin` de antes (lex C-c.4, D113).
 */
import {
  canReadHourlyValue,
  hourlyValueActorOf,
  projectContractedServiceForActor,
  bodyWritesHourlyValue,
  PATIENT_CONTRACT_VALUE_READ_CELL,
  type HourlyValueActor,
} from '../contractedServiceHourlyValueAccess';
import type { Request } from 'express';

const CELL = PATIENT_CONTRACT_VALUE_READ_CELL;

describe('canReadHourlyValue — o engine decidiu (cells é lista)', () => {
  it('com a célula lê, mesmo sem papel admin', () => {
    expect(canReadHourlyValue({ cells: [CELL], roles: ['recruiter'] })).toBe(true);
  });
  it('sem a célula redige, MESMO sendo admin — o papel não é mais nível', () => {
    expect(canReadHourlyValue({ cells: ['patient_services:read'], roles: ['admin'] })).toBe(false);
  });
  it('`[]` é "ator conhecido e sem célula" → redige (nunca vira o caso do null)', () => {
    expect(canReadHourlyValue({ cells: [], roles: ['admin'] })).toBe(false);
  });
});

describe('canReadHourlyValue — o engine NÃO decidiu (cells === null): o que a rota devolvia antes', () => {
  it('papel admin lê', () => {
    expect(canReadHourlyValue({ cells: null, roles: ['admin'] })).toBe(true);
    expect(canReadHourlyValue({ cells: null, roles: ['recruiter', 'admin'] })).toBe(true);
  });
  it('outro papel redige', () => {
    expect(canReadHourlyValue({ cells: null, roles: ['recruiter'] })).toBe(false);
    expect(canReadHourlyValue({ cells: null, roles: ['community_manager'] })).toBe(false);
    expect(canReadHourlyValue({ cells: null, roles: [] })).toBe(false);
  });
  it('roles null (defesa; requireStaff já filtrou) → lê', () => {
    expect(canReadHourlyValue({ cells: null, roles: null })).toBe(true);
  });
});

describe('hourlyValueActorOf', () => {
  it('lê req.user.roles e req.permissionCells', () => {
    const req = { user: { roles: ['admin'] }, permissionCells: [CELL] } as unknown as Request;
    expect(hourlyValueActorOf(req)).toEqual({ cells: [CELL], roles: ['admin'] });
  });
  it('sem middleware nenhum → null nos dois (nunca `[]`)', () => {
    expect(hourlyValueActorOf({} as unknown as Request)).toEqual({ cells: null, roles: null });
  });
  it('req.user sem roles → roles null', () => {
    expect(hourlyValueActorOf({ user: {} } as unknown as Request)).toEqual({ cells: null, roles: null });
  });
});

describe('projectContractedServiceForActor', () => {
  const VAGA = { id: 'v1', caseNumber: 1234, caseOrdinal: 1, status: 'SEARCHING', siteUrl: 'https://exemplo.test/x' };
  const service = { id: 's1', hourlyValue: 1500, liveVacancy: VAGA };
  const le: HourlyValueActor = { cells: [CELL, 'vacancy:read'], roles: null };
  const naoLe: HourlyValueActor = { cells: [], roles: ['admin'] };

  it('quem lê tudo: valor e vaga crus, os dois flags false', () => {
    expect(projectContractedServiceForActor(service, le)).toEqual({
      id: 's1', hourlyValue: 1500, hourlyValueRedacted: false, liveVacancy: VAGA, liveVacancyRedacted: false,
    });
  });

  it('quem não lê nada: hourlyValue e liveVacancy viram null, os dois flags true', () => {
    expect(projectContractedServiceForActor(service, naoLe)).toEqual({
      id: 's1', hourlyValue: null, hourlyValueRedacted: true, liveVacancy: null, liveVacancyRedacted: true,
    });
  });

  it('hourlyValue já null (não informado) + não lê: continua null, mas com o flag', () => {
    const out = projectContractedServiceForActor({ id: 's2', hourlyValue: null, liveVacancy: null }, naoLe);
    expect(out).toEqual({ id: 's2', hourlyValue: null, hourlyValueRedacted: true, liveVacancy: null, liveVacancyRedacted: true });
  });

  it('as duas redações são INDEPENDENTES: sem o preço mas com vacancy:read → vaga visível, valor redigido', () => {
    const out = projectContractedServiceForActor(service, { cells: ['vacancy:read'], roles: null });
    expect(out.hourlyValue).toBeNull();
    expect(out.hourlyValueRedacted).toBe(true);
    expect(out.liveVacancy).toEqual(VAGA);
    expect(out.liveVacancyRedacted).toBe(false);
  });

  it('A3: a vaga projetada tem EXATAMENTE as 5 chaves (nenhum campo de dinheiro entra)', () => {
    const out = projectContractedServiceForActor(service, { cells: ['vacancy:read'], roles: null });
    expect(Object.keys(out.liveVacancy as object).sort()).toEqual(['caseNumber', 'caseOrdinal', 'id', 'siteUrl', 'status']);
  });

  it('A2, os DOIS lados: com vacancy:read e sem vaga → null + false; sem vacancy:read → null + true', () => {
    const semVaga = { id: 's3', hourlyValue: null, liveVacancy: null };
    expect(projectContractedServiceForActor(semVaga, le)).toMatchObject({ liveVacancy: null, liveVacancyRedacted: false });
    expect(projectContractedServiceForActor(semVaga, naoLe)).toMatchObject({ liveVacancy: null, liveVacancyRedacted: true });
  });

  it('cells === null: o papel admin lê a vaga; recrutador não (mesmo padrão do valor-hora)', () => {
    expect(projectContractedServiceForActor(service, { cells: null, roles: ['admin'] }).liveVacancyRedacted).toBe(false);
    expect(projectContractedServiceForActor(service, { cells: null, roles: ['recruiter'] }).liveVacancyRedacted).toBe(true);
    expect(projectContractedServiceForActor(service, { cells: null, roles: null }).liveVacancyRedacted).toBe(false);
  });
});

describe('bodyWritesHourlyValue — pela CHAVE, não pelo valor', () => {
  it('hourlyValue: null é escrita', () => {
    expect(bodyWritesHourlyValue({ hourlyValue: null })).toBe(true);
  });
  it('sem a chave não é', () => {
    expect(bodyWritesHourlyValue({ service: 'x' })).toBe(false);
    expect(bodyWritesHourlyValue(null)).toBe(false);
    expect(bodyWritesHourlyValue('str')).toBe(false);
  });
});
