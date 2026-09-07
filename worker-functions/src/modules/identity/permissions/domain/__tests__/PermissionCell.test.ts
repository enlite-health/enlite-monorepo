import {
  CELL_DESCRIPTION,
  PERMISSION_CATEGORIES,
  RESOURCE_CATEGORY,
  UNCATEGORIZED,
  categoryFor,
  cellKey,
  isValidAction,
  isValidCellKey,
  isValidResource,
  parseCellKey,
} from '../PermissionCell';

describe('PermissionCell', () => {
  it('monta e desmonta a chave canônica', () => {
    expect(cellKey('worker', 'read')).toBe('worker:read');
    expect(parseCellKey('worker_pii:read')).toEqual({ resource: 'worker_pii', action: 'read' });
  });

  it.each([
    ['sem separador', 'worker'],
    ['dois separadores', 'worker:read:extra'],
    ['recurso vazio', ':read'],
    ['ação vazia', 'worker:'],
    ['maiúscula', 'Worker:read'],
    ['começando com dígito', '1worker:read'],
    ['com espaço', 'worker :read'],
  ])('rejeita chave malformada (%s)', (_caso, key) => {
    expect(parseCellKey(key)).toBeNull();
    expect(isValidCellKey(key)).toBe(false);
  });

  it('valida segmentos isoladamente', () => {
    expect(isValidResource('permission_management')).toBe(true);
    expect(isValidResource('Permission')).toBe(false);
    expect(isValidAction('execute')).toBe(true);
    expect(isValidAction('exec-ute')).toBe(false);
  });

  it('categoria vem do mapa por RECURSO — desconhecido não é chutado', () => {
    expect(categoryFor('worker')).toBe('Trabalhadores');
    expect(categoryFor('permission_management')).toBe('Administração');
    expect(categoryFor('recurso_que_nao_existe')).toBe(UNCATEGORIZED);
  });

  it('todo recurso mapeado aponta para uma categoria da lista (sem typo)', () => {
    for (const category of Object.values(RESOURCE_CATEGORY)) {
      expect(PERMISSION_CATEGORIES).toContain(category);
    }
  });

  it('cobre as 3 células da D116 que restaram (`api_docs` saiu com a tela em 07/09)', () => {
    expect(categoryFor('patient')).toBe('Pacientes');
    expect(categoryFor('integration')).toBe('Operações');
    expect(categoryFor('test_fixtures')).toBe('Operações');
  });

  it('`api_docs` saiu das DUAS fontes do catálogo — recurso e descrição', () => {
    expect(RESOURCE_CATEGORY).not.toHaveProperty('api_docs');
    expect(CELL_DESCRIPTION).not.toHaveProperty('api_docs:read');
    // Recurso desconhecido cai no fallback, não explode.
    expect(categoryFor('api_docs')).toBe(UNCATEGORIZED);
  });
});
