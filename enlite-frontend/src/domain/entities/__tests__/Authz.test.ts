import { describe, it, expect } from 'vitest';
import { accessLevelFor, hasCell } from '../Authz';

/**
 * A tabela-verdade da regra por componente. É pura de propósito: se ela
 * estiver errada, TODO componente gated está errado, e este é o lugar mais
 * barato para descobrir.
 */
describe('accessLevelFor', () => {
  it.each([
    [null, 'hidden'],
    [[], 'hidden'],
    [['outro:read', 'outro:write'], 'hidden'],
    [['grupo:read'], 'read'],
    [['grupo:write'], 'write'],
    [['grupo:read', 'grupo:write'], 'write'],
    // delete/export/execute NÃO elevam: são ações próprias
    [['grupo:delete'], 'hidden'],
    [['grupo:read', 'grupo:export'], 'read'],
  ] as const)('permissions=%j → %s', (permissions, esperado) => {
    expect(accessLevelFor(permissions as string[] | null, 'grupo')).toBe(esperado);
  });

  it('não casa por prefixo — `grupo_x:write` não é `grupo:write`', () => {
    expect(accessLevelFor(['grupo_x:write', 'grupos:read'], 'grupo')).toBe('hidden');
  });
});

describe('hasCell', () => {
  it('pergunta pela célula exata', () => {
    expect(hasCell(['worker:export'], 'worker', 'export')).toBe(true);
    expect(hasCell(['worker:export'], 'worker', 'delete')).toBe(false);
    expect(hasCell(null, 'worker', 'export')).toBe(false);
  });
});
