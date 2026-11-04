import {
  SERVICE_TEAM_REVERT_REASONS,
  isAllowedServiceTeamRevertReason,
  ServiceTeamReasonRequiredError,
  ServiceTeamReasonInvalidError,
} from '../serviceTeamReason';

/**
 * A lista de REVERTER TEM que bater com o literal do CHECK da migration 481
 * (`revert_reason_category`, DX-10.3), copiado à mão aqui (não lido do arquivo, não recalculado por
 * `serviceTeamReason.ts`) para que o teste morra se a lista mudar sem migration — molde
 * `moveReason.test.ts:146-176`. O motivo de REJEITAR saiu daqui: é o catálogo `service_exit_reasons`
 * (migration 493, FK), conferido em `ServiceTeamMarkUseCase`.
 */
describe('SERVICE_TEAM_REVERT_REASONS — literal do CHECK da 481', () => {
  const CHECK_481_REVERT_LITERAL = ['REAVALIACAO', 'REJEITADO_POR_ENGANO', 'OTHER'];

  it('tem exatamente os 3 valores do CHECK, sem repetição', () => {
    expect(SERVICE_TEAM_REVERT_REASONS).toHaveLength(3);
    expect(new Set(SERVICE_TEAM_REVERT_REASONS).size).toBe(3);
    expect([...SERVICE_TEAM_REVERT_REASONS].sort()).toEqual([...CHECK_481_REVERT_LITERAL].sort());
  });

  it('não reusa valores exclusivos do quadro B (invariante 6: setores diferentes)', () => {
    expect(SERVICE_TEAM_REVERT_REASONS).not.toContain('ENCUADRE_ANTECIPADO');
    expect(SERVICE_TEAM_REVERT_REASONS).not.toContain('REAPROVEITADO_DE_OUTRA_VAGA');
  });
});

describe('isAllowedServiceTeamRevertReason', () => {
  it('aceita categoria da lista de reverter', () => {
    expect(isAllowedServiceTeamRevertReason('REAVALIACAO')).toBe(true);
    expect(isAllowedServiceTeamRevertReason('OTHER')).toBe(true);
  });

  it('recusa código de rejeição do catálogo (o de reverter é outra pergunta)', () => {
    expect(isAllowedServiceTeamRevertReason('PERFIL_INADEQUADO_AO_SERVICO')).toBe(false);
  });

  it('recusa ausência, undefined e tipo não-string', () => {
    expect(isAllowedServiceTeamRevertReason(undefined)).toBe(false);
    expect(isAllowedServiceTeamRevertReason(42)).toBe(false);
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
