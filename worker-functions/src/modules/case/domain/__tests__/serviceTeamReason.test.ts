import {
  SERVICE_TEAM_REJECT_REASONS,
  SERVICE_TEAM_REVERT_REASONS,
  isAllowedServiceTeamReason,
  ServiceTeamReasonRequiredError,
  ServiceTeamReasonInvalidError,
} from '../serviceTeamReason';

/**
 * As duas listas TÊM que bater com o literal do CHECK da migration 481
 * (`reject_reason_category`/`revert_reason_category`, DX-10.3), copiado à mão aqui (não
 * lido do arquivo, não recalculado por `serviceTeamReason.ts`) para que o teste morra se
 * uma lista mudar sem migration — molde `moveReason.test.ts:146-176`.
 */
describe('SERVICE_TEAM_REJECT_REASONS / SERVICE_TEAM_REVERT_REASONS — literal do CHECK da 481', () => {
  // Literal do CHECK da migration 481, escrito à mão a partir da DX-10.3.
  const CHECK_481_REJECT_LITERAL = [
    'PERFIL_INADEQUADO_AO_SERVICO',
    'INDISPONIBILIDADE_DE_HORARIO',
    'DESISTENCIA_DO_PRESTADOR',
    'OTHER',
  ];
  const CHECK_481_REVERT_LITERAL = ['REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER'];

  it('SERVICE_TEAM_REJECT_REASONS tem exatamente os 4 valores do CHECK, sem repetição', () => {
    expect(SERVICE_TEAM_REJECT_REASONS).toHaveLength(4);
    expect(new Set(SERVICE_TEAM_REJECT_REASONS).size).toBe(4);
    expect([...SERVICE_TEAM_REJECT_REASONS].sort()).toEqual([...CHECK_481_REJECT_LITERAL].sort());
  });

  it('SERVICE_TEAM_REVERT_REASONS tem exatamente os 3 valores do CHECK, sem repetição', () => {
    expect(SERVICE_TEAM_REVERT_REASONS).toHaveLength(3);
    expect(new Set(SERVICE_TEAM_REVERT_REASONS).size).toBe(3);
    expect([...SERVICE_TEAM_REVERT_REASONS].sort()).toEqual([...CHECK_481_REVERT_LITERAL].sort());
  });

  it('nenhuma lista importa/reusa moveReason.ts (invariante 6: setores diferentes)', () => {
    // As duas listas do quadro C não têm nenhum dos valores exclusivos do quadro B
    // (JUMP_REASONS) — a coincidência de REVERT com LEAVE_REJECTED_REASONS é textual, não
    // de import (conferido por leitura de código; aqui só a lista fica isolada e fechada).
    expect(SERVICE_TEAM_REJECT_REASONS).not.toContain('ENCUADRE_ANTECIPADO');
    expect(SERVICE_TEAM_REJECT_REASONS).not.toContain('REAPROVEITADO_DE_OUTRA_VAGA');
  });
});

describe('isAllowedServiceTeamReason', () => {
  it('REJECT: aceita categoria da lista de rejeição', () => {
    expect(isAllowedServiceTeamReason('REJECT', 'OTHER')).toBe(true);
  });

  it('REJECT: recusa categoria da lista de reverter', () => {
    expect(isAllowedServiceTeamReason('REJECT', 'REAVALIACAO')).toBe(false);
  });

  it('REVERT: aceita categoria da lista de reverter', () => {
    expect(isAllowedServiceTeamReason('REVERT', 'REAVALIACAO')).toBe(true);
  });

  it('REVERT: recusa categoria da lista de rejeição', () => {
    expect(isAllowedServiceTeamReason('REVERT', 'PERFIL_INADEQUADO_AO_SERVICO')).toBe(false);
  });

  it('recusa ausência, undefined e tipo não-string', () => {
    expect(isAllowedServiceTeamReason('REJECT', undefined)).toBe(false);
    expect(isAllowedServiceTeamReason('REJECT', 42)).toBe(false);
    expect(isAllowedServiceTeamReason('REVERT', undefined)).toBe(false);
    expect(isAllowedServiceTeamReason('REVERT', 42)).toBe(false);
  });

  it('OTHER é aceito nos dois kinds', () => {
    expect(isAllowedServiceTeamReason('REJECT', 'OTHER')).toBe(true);
    expect(isAllowedServiceTeamReason('REVERT', 'OTHER')).toBe(true);
  });
});

describe('ServiceTeamReasonRequiredError / ServiceTeamReasonInvalidError', () => {
  it('carregam o kind e um nome de classe distinto (o controller usa para montar o 422)', () => {
    const required = new ServiceTeamReasonRequiredError('REJECT');
    expect(required.kind).toBe('REJECT');
    expect(required.name).toBe('ServiceTeamReasonRequiredError');
    expect(required).toBeInstanceOf(Error);

    const invalid = new ServiceTeamReasonInvalidError('REVERT');
    expect(invalid.kind).toBe('REVERT');
    expect(invalid.name).toBe('ServiceTeamReasonInvalidError');
    expect(invalid).toBeInstanceOf(Error);
  });
});
