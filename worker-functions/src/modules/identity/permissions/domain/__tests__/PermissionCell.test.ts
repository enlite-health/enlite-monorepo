import {
  CELL_DESCRIPTION,
  PERMISSION_CATEGORIES,
  RESOURCE_CATEGORY,
  SPLIT_RESOURCES,
  UNCATEGORIZED,
  categoryFor,
  cellKey,
  expandWriteCells,
  isSplitResource,
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

  it('cobre as 4 células novas da D116', () => {
    expect(categoryFor('patient')).toBe('Pacientes');
    expect(categoryFor('integration')).toBe('Operações');
    expect(categoryFor('test_fixtures')).toBe('Operações');
    expect(categoryFor('api_docs')).toBe('Operações');
  });
});

// ── spec 018, PR-8b (ADR-2/SUP-30): split write → create+update ────────────────
describe('SPLIT_RESOURCES / isSplitResource', () => {
  it('tem exatamente os 18 recursos com write LITERAL na rota + os 4 por variável (22 no total)', () => {
    // 18 literais: `git grep -n "perm\.require([^)]*'write'" -- worker-functions/src | grep -v __tests__`
    // menos `permission_management` (medido 15/09, 93 hits — excluir por CAMINHO `__tests__`,
    // nunca por substring "test" na linha, que corta `/workers/:id/test-flag` e
    // `/patients/:id/test-flag`, ambos `worker`/`patient`, já cobertos aqui → 20 recursos
    // distintos − 1). `worker` SAIU em 21/09 (spec 024, D401): nunca teve `perm.require('worker',
    // 'create', …)` — quem usava `worker:create` era a tag, migrada pra `tag:create` (célula
    // própria, fora do split). `worker` mantém só `:update` daqui pra frente.
    const literais = [
      'funnel', 'interview', 'messaging', 'patient', 'patient_address', 'patient_care_team',
      'patient_chat', 'patient_clinical', 'patient_coverage', 'patient_family', 'patient_identity',
      'patient_services', 'prescreening', 'recruitment', 'talentum', 'user_management', 'vacancy',
      'worker_document',
    ];
    const porVariavel = [
      'patient_therapeutic_project', 'catalog_therapeutic_objectives',
      'catalog_therapeutic_activities', 'catalog_therapeutic_segments',
    ];
    expect([...SPLIT_RESOURCES].sort()).toEqual([...literais, ...porVariavel].sort());
    expect(SPLIT_RESOURCES.size).toBe(22);
  });

  it('permission_management NUNCA é recurso splitado — é a única rota que continua sob write', () => {
    expect(isSplitResource('permission_management')).toBe(false);
  });

  it('worker SAIU de SPLIT_RESOURCES em 21/09 (spec 024) — só `tag` cria dentro do que era `worker:*`', () => {
    expect(isSplitResource('worker')).toBe(false);
    expect(CELL_DESCRIPTION['worker:create']).toBeUndefined();
  });

  it('cada um dos 22 recursos splitados tem CELL_DESCRIPTION para create E update', () => {
    for (const resource of SPLIT_RESOURCES) {
      expect(CELL_DESCRIPTION[cellKey(resource, 'create')]?.trim().length ?? 0).toBeGreaterThan(0);
      expect(CELL_DESCRIPTION[cellKey(resource, 'update')]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('expandWriteCells', () => {
  it('expande write de recurso splitado em create + update', () => {
    expect(expandWriteCells(['patient_family:write'])).toEqual(['patient_family:create', 'patient_family:update']);
  });

  it('NÃO mexe em permission_management:write (fica write)', () => {
    expect(expandWriteCells(['permission_management:write'])).toEqual(['permission_management:write']);
  });

  it('NÃO mexe em write de recurso não splitado (nem em read/create/update já expandidos)', () => {
    expect(expandWriteCells(['dedup:write'])).toEqual(['dedup:write']);
    // `worker` SAIU de SPLIT_RESOURCES em 21/09 (spec 024) — `worker:read` já provava "recurso
    // não splitado" antes disso, e continua provando agora por um motivo diferente.
    expect(expandWriteCells(['worker:read'])).toEqual(['worker:read']);
    expect(expandWriteCells(['worker_document:create', 'worker_document:update'])).toEqual(['worker_document:create', 'worker_document:update']);
  });

  it('dedup: já ter create/update + mandar write de novo não duplica', () => {
    expect(expandWriteCells(['vacancy:create', 'vacancy:write', 'vacancy:update'])).toEqual(['vacancy:create', 'vacancy:update']);
  });

  it('mistura: só as células splitadas mudam, o resto passa intacto, ordem de entrada preservada por grupo', () => {
    const out = expandWriteCells(['worker:read', 'patient_family:write', 'permission_management:write']);
    expect(out).toEqual(['worker:read', 'patient_family:create', 'patient_family:update', 'permission_management:write']);
  });

  it('lista vazia devolve lista vazia', () => {
    expect(expandWriteCells([])).toEqual([]);
  });
});
