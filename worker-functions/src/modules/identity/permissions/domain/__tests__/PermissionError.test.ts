import { PermissionError, isPermissionError, toPermissionError } from '../PermissionError';

/** Molde do erro que o driver `pg` entrega quando a função da 279 levanta. */
function pgError(code: string, message: string, constraint?: string): Error {
  return Object.assign(new Error(message), { code, constraint });
}

describe('toPermissionError — SQLSTATE das funções da 279 → vocabulário do módulo', () => {
  it.each([
    ['42501', '[iam] permission_management:write ausente para o ator', 'forbidden'],
    ['P0002', '[iam] grupo inexistente ou arquivado', 'not_found'],
    ['23502', '[iam] concessão de país exige motivo', 'reason_required'],
    ['23503', '[iam] 2 célula(s) fora do catálogo', 'invalid_cell'],
    ['23505', 'duplicate key value violates unique constraint', 'duplicate_name'],
  ])('%s → %s', (code, message, expected) => {
    const mapped = toPermissionError(pgError(code, message));
    expect(isPermissionError(mapped)).toBe(true);
    expect((mapped as PermissionError).code).toBe(expected);
  });

  it('23514 distingue anti-lockout de grupo de sistema pela marca da migration', () => {
    const lockout = toPermissionError(
      pgError('23514', '[iam] operação rejeitada: deixaria ZERO gestores (anti-lockout)'),
    ) as PermissionError;
    const system = toPermissionError(
      pgError('23514', '[iam] grupo de sistema não pode ser arquivado'),
    ) as PermissionError;
    expect(lockout.code).toBe('last_manager');
    expect(system.code).toBe('system_group');
  });

  it('23514 vindo de CHECK de TABELA (traz `constraint`) não vira "grupo de sistema"', () => {
    const featureKey = toPermissionError(
      pgError('23514', 'violates check constraint', 'country_features_feature_key_check'),
    ) as PermissionError;
    const outro = toPermissionError(
      pgError('23514', 'violates check constraint', 'country_features_country_check'),
    ) as PermissionError;
    expect(featureKey.code).toBe('invalid_feature_key');
    expect(outro.code).toBe('invalid_input');
  });

  it('SQLSTATE desconhecido e erro sem code voltam INTACTOS (nunca viram 403 mudo)', () => {
    const desconhecido = pgError('40001', 'serialization failure');
    expect(toPermissionError(desconhecido)).toBe(desconhecido);
    const semCode = new Error('conexão caiu');
    expect(toPermissionError(semCode)).toBe(semCode);
    expect(toPermissionError('string solta')).toBe('string solta');
    expect(toPermissionError(null)).toBeNull();
  });

  it('erro com SQLSTATE mas SEM mensagem ainda é classificado', () => {
    const semMensagem = { code: '23514' } as unknown;
    expect((toPermissionError(semMensagem) as PermissionError).code).toBe('system_group');
  });

  it('preserva a causa para diagnóstico', () => {
    const original = pgError('42501', 'sem célula');
    const mapped = toPermissionError(original) as PermissionError;
    expect(mapped.cause).toBe(original);
    expect(mapped.name).toBe('PermissionError');
    expect(isPermissionError(new Error('x'))).toBe(false);
  });
});
