import {
  GROUP_NAME_MAX,
  REASON_MAX,
  assertNotSystemGroup,
  assertSupportedCountry,
  assertValidGroupName,
  assertValidReason,
  containsLikelyPersonalData,
  isLiveGroup,
} from '../PermissionGroup';
import { isLiveGrant, isLiveMembership } from '../GroupMembership';
import type { PermissionError } from '../PermissionError';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as PermissionError).code;
  }
  return 'não lançou';
}

describe('assertValidGroupName', () => {
  it('normaliza espaços das bordas', () => {
    expect(assertValidGroupName('  Recrutamento Brasil  ')).toBe('Recrutamento Brasil');
  });

  it('nome ausente é tratado como vazio (entrada de borda, não crash)', () => {
    expect(codeOf(() => assertValidGroupName(undefined as unknown as string))).toBe('invalid_input');
  });

  it('rejeita nome curto demais e longo demais', () => {
    expect(codeOf(() => assertValidGroupName('ab'))).toBe('invalid_input');
    expect(codeOf(() => assertValidGroupName('x'.repeat(GROUP_NAME_MAX + 1)))).toBe('invalid_input');
    expect(assertValidGroupName('x'.repeat(GROUP_NAME_MAX))).toHaveLength(GROUP_NAME_MAX);
  });
});

describe('grupo de sistema e ciclo de vida', () => {
  it('grupo de sistema recusa a operação com o motivo certo', () => {
    expect(codeOf(() => assertNotSystemGroup({ isSystem: true }, 'arquivar'))).toBe('system_group');
    expect(() => assertNotSystemGroup({ isSystem: false }, 'arquivar')).not.toThrow();
  });

  it('vivo = sem archived_at / removed_at / revoked_at', () => {
    expect(isLiveGroup({ archivedAt: null })).toBe(true);
    expect(isLiveGroup({ archivedAt: new Date() })).toBe(false);
    expect(isLiveMembership({ removedAt: null })).toBe(true);
    expect(isLiveMembership({ removedAt: new Date() })).toBe(false);
    expect(isLiveGrant({ revokedAt: null })).toBe(true);
    expect(isLiveGrant({ revokedAt: new Date() })).toBe(false);
  });
});

describe('assertSupportedCountry', () => {
  it('aceita as jurisdições da fonte única e recusa o resto', () => {
    expect(assertSupportedCountry('AR')).toBe('AR');
    expect(assertSupportedCountry('BR')).toBe('BR');
    expect(codeOf(() => assertSupportedCountry('US'))).toBe('invalid_country');
    expect(codeOf(() => assertSupportedCountry(undefined))).toBe('invalid_country');
  });
});

describe('assertValidReason (lex C10 — trilha de decisão, não de titular)', () => {
  it('exige motivo e devolve normalizado', () => {
    expect(assertValidReason('  expansão para o Brasil ')).toBe('expansão para o Brasil');
    expect(codeOf(() => assertValidReason('   '))).toBe('reason_required');
    expect(codeOf(() => assertValidReason(null))).toBe('reason_required');
  });

  it('recusa motivo com cara de dado de pessoa', () => {
    expect(codeOf(() => assertValidReason('acesso pedido por flor@enlite.health'))).toBe('invalid_input');
    expect(codeOf(() => assertValidReason('para o caso do DNI 20345678'))).toBe('invalid_input');
    expect(codeOf(() => assertValidReason('contato +54 9 11 2345 6789'))).toBe('invalid_input');
  });

  it('aceita motivo administrativo com número curto (nº de ticket)', () => {
    expect(assertValidReason('conforme card 1234')).toBe('conforme card 1234');
    expect(containsLikelyPersonalData('conforme card 1234')).toBe(false);
  });

  it('recusa motivo acima do teto', () => {
    expect(codeOf(() => assertValidReason('a'.repeat(REASON_MAX + 1)))).toBe('invalid_input');
  });
});
