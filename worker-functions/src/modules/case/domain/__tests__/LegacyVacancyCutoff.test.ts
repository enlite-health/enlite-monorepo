import { classifyLegacyVacancy, isGroupE, patientIsGone, BAIXAR_GROUPS, type LegacyVacancyFacts } from '../LegacyVacancyCutoff';

const base: LegacyVacancyFacts = {
  status: 'SEARCHING', isDraft: false, hasPatientId: true, patientExists: true, patientStatus: 'ACTIVE',
  patientServiceCount: 0, patientActiveServiceCount: 0,
};
const f = (o: Partial<LegacyVacancyFacts>): LegacyVacancyFacts => ({ ...base, ...o });

describe('linha de corte — classificação (spec 084 F3, R15/R19)', () => {
  it('a: aberta de paciente que deu baixa (DISCHARGED, ALTA) ou paciente apagado', () => {
    expect(classifyLegacyVacancy(f({ patientStatus: 'DISCHARGED' })).group).toBe('a');
    expect(classifyLegacyVacancy(f({ patientStatus: 'ALTA' })).group).toBe('a');
    expect(classifyLegacyVacancy(f({ patientExists: false, patientStatus: null })).group).toBe('a');
  });

  it('x: aberta SEM paciente ligado', () => {
    expect(classifyLegacyVacancy(f({ hasPatientId: false, patientExists: false, patientStatus: null })).group).toBe('x');
  });

  it('b: aberta de paciente ativo SEM serviço nenhum cadastrado (qualquer estado de paciente que não seja baixa)', () => {
    for (const patientStatus of ['ACTIVE', 'SUSPENDED', 'REPLACEMENT', 'SEARCHING']) {
      expect(classifyLegacyVacancy(f({ patientStatus })).group).toBe('b');
    }
  });

  it('c: aberta de paciente ativo COM serviço ativo (817) — vai a merge+baixa, só com destino no mapa', () => {
    expect(classifyLegacyVacancy(f({ patientServiceCount: 3, patientActiveServiceCount: 3 })).group).toBe('c');
  });

  it('paciente só com serviço INATIVO não cai em b nem c: lista de revisão (nunca baixa por chute)', () => {
    expect(classifyLegacyVacancy(f({ patientServiceCount: 1, patientActiveServiceCount: 0 }))).toEqual({
      group: 'revisao', reviewReason: 'PACIENTE_SO_SERVICO_INATIVO',
    });
  });

  it('d: encerrada baixa SEMPRE (de baixa, de ativo ou sem paciente) — as 61', () => {
    for (const o of [{ patientStatus: 'DISCHARGED' }, { patientStatus: 'ACTIVE' }, { hasPatientId: false, patientExists: false, patientStatus: null }]) {
      expect(classifyLegacyVacancy(f({ status: 'CLOSED', ...o })).group).toBe('d-baixar');
    }
  });

  it('d: suspensa / "Activo" de paciente com baixa → baixa (as 19)', () => {
    for (const status of ['SUSPENDED', 'ACTIVE']) {
      expect(classifyLegacyVacancy(f({ status, patientStatus: 'DISCHARGED' })).group).toBe('d-baixar');
    }
  });

  it('d: suspensa / "Activo" de paciente ATIVO → lista de revisão, NÃO baixa (as 22 + 8)', () => {
    for (const status of ['SUSPENDED', 'ACTIVE']) {
      const d = classifyLegacyVacancy(f({ status, patientServiceCount: 2, patientActiveServiceCount: 2 }));
      expect(d).toEqual({ group: 'revisao', reviewReason: 'NAO_ABERTA_PACIENTE_ATIVO' });
      expect(BAIXAR_GROUPS).not.toContain(d.group);
    }
  });

  it('rascunho sem serviço nunca é "aberta" (SUP-3) nem é baixado: revisão', () => {
    expect(classifyLegacyVacancy(f({ isDraft: true }))).toEqual({ group: 'revisao', reviewReason: 'RASCUNHO_SEM_SERVICO' });
  });

  it('o grupo c NUNCA está entre os que baixam sozinhos; só a, b, x, d-baixar', () => {
    expect([...BAIXAR_GROUPS].sort()).toEqual(['a', 'b', 'd-baixar', 'x']);
  });

  it('e: só vaga de serviço ATIVO hoje CLOSED; suspensa (SUP-2) e serviço inativo ficam como estão', () => {
    expect(isGroupE({ status: 'CLOSED', serviceActive: true })).toBe(true);
    expect(isGroupE({ status: 'SUSPENDED', serviceActive: true })).toBe(false);
    expect(isGroupE({ status: 'CLOSED', serviceActive: false })).toBe(false);
  });

  it('patientIsGone: sem paciente ligado NÃO é "baixa" (é o grupo x)', () => {
    expect(patientIsGone({ hasPatientId: false, patientExists: false, patientStatus: null })).toBe(false);
  });
});
