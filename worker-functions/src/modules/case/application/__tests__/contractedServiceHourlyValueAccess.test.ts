/**
 * contractedServiceHourlyValueAccess — o preço do contrato sai pela célula
 * `patient_contract_value:read`; sem decisão do engine (`cells === null`), pelo
 * papel `admin` de antes (lex C-c.4, D113).
 */
import {
  canReadHourlyValue,
  hourlyValueActorOf,
  projectContractedServiceForActor,
  redactTermForActor,
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

const COVERAGE_CELL = 'patient_coverage:read';
const NAMES = { providerCode: 'OSDE', providerName: 'OSDE', contractId: 'c1', contractName: 'OSDE 210', payerKind: 'OBRA_SOCIAL' as const };
const LINKED = { state: 'LINKED' as const, isPrivate: false, validFrom: '2026-01-01', validTo: null, names: NAMES };
const PRECO = { state: 'OK' as const, hourlyRate: 1500, currency: 'ARS' as const };

function servico(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    liveVacancy: { id: 'v1', caseNumber: 1234, caseOrdinal: 1, status: 'SEARCHING' } as unknown,
    payer: LINKED,
    payerHistory: [{ linkId: 'l1', isPrivate: false, validFrom: '2026-01-01', validTo: null, names: NAMES }],
    price: PRECO as { state: string },
    tax: { state: 'OK', taxRatePercent: 21 },
    coverageMatch: { state: 'MATCH' as const },
    ...over,
  } as never as Parameters<typeof projectContractedServiceForActor>[0] & { tax: unknown; id: string };
}

describe('redactTermForActor — §0: o preço sai só pela célula de valor', () => {
  const le: HourlyValueActor = { cells: [CELL], roles: null };
  const naoLe: HourlyValueActor = { cells: [], roles: ['admin'] };

  it('lista E3: currentTerm.price OK sem a célula vira REDACTED; com a célula passa cru', () => {
    expect(redactTermForActor(PRECO, naoLe)).toEqual({ state: 'REDACTED' });
    expect(redactTermForActor(PRECO, le)).toEqual(PRECO);
  });

  it('serviço: price.state OK sem a célula vira REDACTED na projeção; com a célula passa cru', () => {
    expect(projectContractedServiceForActor(servico(), naoLe).price).toEqual({ state: 'REDACTED' });
    expect(projectContractedServiceForActor(servico(), le).price).toEqual(PRECO);
  });

  it('NO_CONTRACT/NO_TERM não são redigidos (é o portão do vínculo, não o do valor) e o imposto nunca é', () => {
    expect(redactTermForActor({ state: 'NO_CONTRACT' }, naoLe)).toEqual({ state: 'NO_CONTRACT' });
    expect(redactTermForActor({ state: 'NO_TERM' }, naoLe)).toEqual({ state: 'NO_TERM' });
    expect((projectContractedServiceForActor(servico(), naoLe) as unknown as { tax: unknown }).tax).toEqual({ state: 'OK', taxRatePercent: 21 });
  });
});

describe('projectContractedServiceForActor', () => {
  const VAGA = { id: 'v1', caseNumber: 1234, caseOrdinal: 1, status: 'SEARCHING' };
  const le: HourlyValueActor = { cells: [CELL, COVERAGE_CELL, 'vacancy:read'], roles: null };
  const naoLe: HourlyValueActor = { cells: [], roles: ['admin'] };

  it('quem lê tudo: preço, nomes, divergência e vaga crus; vaga não redigida', () => {
    const out = projectContractedServiceForActor(servico(), le);
    expect(out).toMatchObject({ price: PRECO, payer: LINKED, coverageMatch: { state: 'MATCH' }, liveVacancy: VAGA, liveVacancyRedacted: false });
    expect(out.payerHistory[0].names).toEqual(NAMES);
    expect(out).not.toHaveProperty('hourlyValue');
    expect(out).not.toHaveProperty('hourlyValueRedacted');
  });

  it('sem a célula coverage: names/payerKind somem (atual e histórico) e coverageMatch vira REDACTED; isPrivate e a vigência ficam', () => {
    const out = projectContractedServiceForActor(servico(), { cells: [CELL], roles: null });
    expect(out.payer).toEqual({ state: 'LINKED', isPrivate: false, validFrom: '2026-01-01', validTo: null, names: null });
    expect(out.payerHistory.map((h) => h.names)).toEqual([null]);
    expect(out.coverageMatch).toEqual({ state: 'REDACTED' });
    expect(JSON.stringify(out)).not.toContain('OBRA_SOCIAL');
    expect(JSON.stringify(out)).not.toContain('OSDE');
  });

  it('sem vínculo (NO_CONTRACT) o payer passa intacto, mesmo sem a célula', () => {
    const out = projectContractedServiceForActor(servico({ payer: { state: 'NO_CONTRACT' }, payerHistory: [] }), { cells: [], roles: null });
    expect(out.payer).toEqual({ state: 'NO_CONTRACT' });
  });

  it('particular sem coverage: isPrivate continua visível (o decisor 1 não depende de coverage)', () => {
    const priv = { ...LINKED, isPrivate: true, names: { ...NAMES, providerCode: 'PRIVATE', payerKind: 'PRIVATE' as const } };
    const out = projectContractedServiceForActor(servico({ payer: priv }), { cells: [], roles: null });
    expect(out.payer).toMatchObject({ state: 'LINKED', isPrivate: true });
  });

  it('quem não lê nada: preço REDACTED, nomes null, vaga null + flag', () => {
    const out = projectContractedServiceForActor(servico(), naoLe);
    expect(out.price).toEqual({ state: 'REDACTED' });
    expect(out.liveVacancy).toBeNull();
    expect(out.liveVacancyRedacted).toBe(true);
  });

  it('as redações são INDEPENDENTES: sem o preço mas com vacancy:read e coverage → vaga e nomes visíveis, preço redigido', () => {
    const out = projectContractedServiceForActor(servico(), { cells: ['vacancy:read', COVERAGE_CELL], roles: null });
    expect(out.price).toEqual({ state: 'REDACTED' });
    expect(out.liveVacancy).toEqual(VAGA);
    expect(out.liveVacancyRedacted).toBe(false);
    expect((out.payer as { names: unknown }).names).toEqual(NAMES);
  });

  it('A3: a vaga projetada tem EXATAMENTE as 4 chaves (nenhum campo de dinheiro entra)', () => {
    const out = projectContractedServiceForActor(servico(), { cells: ['vacancy:read'], roles: null });
    expect(Object.keys(out.liveVacancy as object).sort()).toEqual(['caseNumber', 'caseOrdinal', 'id', 'status']);
  });

  it('A2, os DOIS lados: com vacancy:read e sem vaga → null + false; sem vacancy:read → null + true', () => {
    const semVaga = servico({ liveVacancy: null });
    expect(projectContractedServiceForActor(semVaga, le)).toMatchObject({ liveVacancy: null, liveVacancyRedacted: false });
    expect(projectContractedServiceForActor(semVaga, naoLe)).toMatchObject({ liveVacancy: null, liveVacancyRedacted: true });
  });

  it('cells === null: admin lê vaga e preço; recrutador não; roles null lê (mesmo padrão do valor-hora). coverage lê com cells null', () => {
    expect(projectContractedServiceForActor(servico(), { cells: null, roles: ['admin'] }).liveVacancyRedacted).toBe(false);
    expect(projectContractedServiceForActor(servico(), { cells: null, roles: ['recruiter'] }).liveVacancyRedacted).toBe(true);
    expect(projectContractedServiceForActor(servico(), { cells: null, roles: null }).liveVacancyRedacted).toBe(false);
    expect(projectContractedServiceForActor(servico(), { cells: null, roles: ['recruiter'] }).price).toEqual({ state: 'REDACTED' });
    expect((projectContractedServiceForActor(servico(), { cells: null, roles: ['recruiter'] }).payer as { names: unknown }).names).toEqual(NAMES);
  });
});
